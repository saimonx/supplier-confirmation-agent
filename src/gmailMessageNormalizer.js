'use strict';

// Pure normalization of Gmail API messages ('full' format).
// No access to the network or environment variables: google.js passes in our own
// addresses and the history-cleaning function, and the tests use it with
// hand-built messages.

const BOUNCE_SENDER_PATTERN = /^(mailer-daemon|postmaster)(\+[^@]*)?@/i;
const EMAIL_PATTERN = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const MAX_TEXT_BODY_LENGTH = 20000;

function decodeBase64Url(data) {
    if (!data) return '';
    const normalized = String(data).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf-8');
}

function getHeader(headers, name) {
    if (!Array.isArray(headers)) return '';
    const lowerName = name.toLowerCase();
    const header = headers.find(item => item && String(item.name || '').toLowerCase() === lowerName);
    return header && header.value ? String(header.value) : '';
}

// Extracts the address from a header value such as "Name <email@domain>"
function extractEmailAddress(value) {
    if (!value) return '';
    const angle = String(value).match(/<([^>]+)>/);
    const candidate = angle ? angle[1] : String(value);
    const match = candidate.match(EMAIL_PATTERN);
    return match ? match[0].toLowerCase() : '';
}

function getEmailDomain(email) {
    const address = extractEmailAddress(email);
    const index = address.lastIndexOf('@');
    return index === -1 ? '' : address.slice(index + 1);
}

// Walks all MIME parts (including nested ones) and returns their decoded content
function collectParts(payload) {
    const parts = [];

    function visit(part, depth) {
        if (!part || depth > 20) return;
        parts.push({
            mimeType: String(part.mimeType || '').toLowerCase(),
            headers: Array.isArray(part.headers) ? part.headers : [],
            content: part.body && part.body.data ? decodeBase64Url(part.body.data) : ''
        });
        if (Array.isArray(part.parts)) {
            part.parts.forEach(child => visit(child, depth + 1));
        }
    }

    visit(payload, 0);
    return parts;
}

function decodeHtmlEntities(text) {
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/gi, '\'')
        .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(Number(code)))
        .replace(/&amp;/gi, '&');
}

// Simple HTML to plain text conversion for the classifier
function htmlToText(html) {
    if (!html) return '';
    const text = String(html)
        .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return decodeHtmlEntities(text)
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Reads the "Key: value" fields of a message/delivery-status part (RFC 3464)
function parseDeliveryStatusFields(content) {
    const fields = {};
    if (!content) return fields;
    // Lines starting with a space continue the previous field
    const unfolded = String(content).replace(/\r?\n[ \t]+/g, ' ');
    unfolded.split(/\r?\n/).forEach(line => {
        const match = line.match(/^([A-Za-z-]+):\s*(.*)$/);
        if (!match) return;
        const key = match[1].toLowerCase();
        // Keep the first value (first recipient in the report)
        if (!(key in fields)) {
            fields[key] = match[2].trim();
        }
    });
    return fields;
}

// Determines whether the message is a bounce and extracts recipient and detail
function parseBounce({ fromEmail, payload, parts, plainText }) {
    const topContentType = getHeader(payload && payload.headers, 'Content-Type').toLowerCase();
    const deliveryStatusPart = parts.find(part => part.mimeType === 'message/delivery-status');
    const isReport = (payload && String(payload.mimeType || '').toLowerCase() === 'multipart/report' && topContentType.includes('delivery-status')) ||
        (topContentType.includes('multipart/report') && topContentType.includes('delivery-status')) ||
        Boolean(deliveryStatusPart);
    const isBounceSender = BOUNCE_SENDER_PATTERN.test(fromEmail || '');

    if (!isReport && !isBounceSender) {
        return { isBounce: false, bouncedRecipient: null, bounceAction: null, bounceStatus: null, bounceDetail: null };
    }

    const fields = parseDeliveryStatusFields(deliveryStatusPart ? deliveryStatusPart.content : '');
    const failedHeader = getHeader(payload && payload.headers, 'X-Failed-Recipients');
    const recipientField = fields['final-recipient'] || fields['original-recipient'] || '';
    // "rfc822; email@domain" → email@domain
    const recipientFromStatus = extractEmailAddress(recipientField.replace(/^[^;]*;/, ''));
    const bouncedRecipient = extractEmailAddress(failedHeader) || recipientFromStatus || null;

    const bounceAction = fields.action ? fields.action.toLowerCase() : null;
    const bounceStatus = fields.status || null;
    const diagnostic = fields['diagnostic-code'] ? fields['diagnostic-code'].replace(/^[^;]*;\s*/, '') : '';
    const bounceDetail = (diagnostic || (plainText || '').slice(0, 500)).trim() || null;

    return { isBounce: true, bouncedRecipient, bounceAction, bounceStatus, bounceDetail };
}

// A "hard" bounce: permanent delivery failure. Delay notices (4.x.x / delayed) do not count
function isHardBounce(message) {
    if (!message || !message.isBounce) return false;
    const action = message.bounceAction || '';
    if (['delayed', 'delivered', 'relayed', 'expanded'].includes(action)) return false;
    if (message.bounceStatus && /^4\./.test(message.bounceStatus)) return false;
    // Gmail does not always include Action/Status in delay notices: the subject and body are checked too.
    if (/\(delay\)|delayed|retrasad|delivery incomplete|entrega incompleta/i.test(message.subject || '')) return false;
    if (/delivery incomplete|has been delayed|will retry|seguirá intentando|se ha retrasado/i.test(message.textBody || '')) return false;
    return true;
}

function isAutoReplyMessage(headers) {
    const autoSubmitted = getHeader(headers, 'Auto-Submitted').toLowerCase();
    const precedence = getHeader(headers, 'Precedence').toLowerCase();
    return (autoSubmitted && autoSubmitted !== 'no') ||
        Boolean(getHeader(headers, 'X-Autoreply')) ||
        Boolean(getHeader(headers, 'X-Autorespond')) ||
        ['auto_reply', 'auto-reply'].includes(precedence);
}

/**
 * Normalizes a Gmail message (users.messages.get / threads.get with format 'full').
 * @param {object} message - Gmail API message
 * @param {object} options
 * @param {string[]} options.ourEmails - Our own addresses (aliases and impersonated mailbox)
 * @param {function} options.cleanHistory - (content, isHtml) => content without quoted history
 * @returns {object} Normalized message
 */
function normalizeGmailMessage(message, { ourEmails = [], cleanHistory = null } = {}) {
    const payload = (message && message.payload) || {};
    const headers = Array.isArray(payload.headers) ? payload.headers : [];
    const parts = collectParts(payload);

    const from = getHeader(headers, 'From');
    const fromEmail = extractEmailAddress(from);
    const internalDate = Number(message && message.internalDate) || 0;
    const labelIds = (message && message.labelIds) || [];

    const plainText = parts.filter(part => part.mimeType === 'text/plain').map(part => part.content).join('\n');
    const htmlText = parts.filter(part => part.mimeType === 'text/html').map(part => part.content).join('\n');

    // Text without quoted history: plain text first, otherwise converted HTML
    let textBody = '';
    if (plainText.trim()) {
        textBody = cleanHistory ? cleanHistory(plainText, false) : plainText;
        if (!String(textBody || '').trim()) textBody = plainText;
    } else if (htmlText.trim()) {
        const cleanedHtml = cleanHistory ? cleanHistory(htmlText, true) : htmlText;
        textBody = htmlToText(cleanedHtml) || htmlToText(htmlText);
    }
    textBody = String(textBody || '').trim().slice(0, MAX_TEXT_BODY_LENGTH);

    const ownEmails = ourEmails.map(email => extractEmailAddress(email)).filter(Boolean);
    const bounce = parseBounce({ fromEmail, payload, parts, plainText: plainText || htmlToText(htmlText) });
    const isFromUs = !bounce.isBounce && (ownEmails.includes(fromEmail) || labelIds.includes('SENT'));

    const normalized = {
        id: message && message.id,
        threadId: message && message.threadId,
        from,
        fromEmail,
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject'),
        date: new Date(internalDate),
        internalDate,
        labelIds,
        rfcMessageId: getHeader(headers, 'Message-ID') || null,
        inReplyTo: getHeader(headers, 'In-Reply-To') || null,
        references: getHeader(headers, 'References') || null,
        isFromUs,
        isAutoReply: isAutoReplyMessage(headers),
        isBounce: bounce.isBounce,
        bouncedRecipient: bounce.bouncedRecipient,
        bounceAction: bounce.bounceAction,
        bounceStatus: bounce.bounceStatus,
        bounceDetail: bounce.bounceDetail,
        textBody
    };

    if (bounce.isBounce) {
        // Full text (nested parts and headers) to link the bounce to the original send
        normalized.bounceSearchText = parts
            .map(part => [part.content, part.headers.map(header => `${header.name}: ${header.value}`).join('\n')].join('\n'))
            .join('\n')
            .slice(0, 100000);
    }

    return normalized;
}

module.exports = {
    decodeBase64Url,
    getHeader,
    extractEmailAddress,
    getEmailDomain,
    htmlToText,
    parseDeliveryStatusFields,
    isHardBounce,
    normalizeGmailMessage
};
