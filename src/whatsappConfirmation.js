const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { detectProviderLanguage } = require('./language');

// Generic auto replies to the supplier (automationKind of WhatsappMessage).
const AUTO_REPLY_KINDS = [
    'provider_auto_reply_es',
    'provider_auto_reply_en',
    'provider_auto_reply_fallback_es',
    'provider_auto_reply_fallback_en',
    'provider_auto_reply_test'
];

// Dependencies loaded on demand: avoids the cycle with whatsapp.js and allows
// testing the pure functions without models or network.
function getModels() {
    return require('./adapters/models');
}
function getWhatsapp() {
    return require('./adapters/whatsapp');
}
function getNotificationAdmin() {
    return require('./adapters/notificationAdmin');
}

const TIMEZONE = 'Europe/Madrid';
const CONTEXT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_LISTED = 5;
const DEFAULT_QUOTE_LENGTH = 400;
const TEMPLATE_CACHE_MS = 10 * 60 * 1000;

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function isSpanishSpeakingCountry(phoneNumber) {
    return detectProviderLanguage({ phone: phoneNumber }) === 'es';
}

// DD/MM/YYYY -> "13 de Abril" / "April 13th" (same as formatDateNatural in the frontend).
function formatDateNatural(dateStr, isSpanish = true) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('/');
    if (parts.length !== 3) return dateStr;
    const date = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
    if (isNaN(date.getTime())) return dateStr;

    const day = date.getDate();
    const month = date.getMonth();
    if (isSpanish) return `${day} de ${MONTHS_ES[month]}`;

    let suffix = 'th';
    if (day < 11 || day > 13) {
        const lastDigit = day % 10;
        if (lastDigit === 1) suffix = 'st';
        else if (lastDigit === 2) suffix = 'nd';
        else if (lastDigit === 3) suffix = 'rd';
    }
    return `${MONTHS_EN[month]} ${day}${suffix}`;
}

// Fields of each template in the order of its variables {{1}}..{{n}} (see frontend).
function buildTemplateFields(service, variant) {
    const isSpanish = variant.lang === 'es';
    const field = (labelEs, labelEn, value) => ({
        label: isSpanish ? labelEs : labelEn,
        labelEs,
        value: value || ''
    });
    const date = field('Fecha', 'Date', formatDateNatural(service.dateStart, isSpanish));
    const hour = field('Hora', 'Time', service.dateStartHour);
    const airport = field('Aeropuerto', 'Airport', service.transferPickupDropffAirport);
    const hotel = field('Hotel', 'Hotel', service.transferActivityHotelName);
    const flight = field('Número de vuelo', 'Flight number', service.transferFlightCode);
    const client = field('Nombre del cliente', 'Client name', service.activityTransferClientFullName);
    const activity = field('Actividad', 'Activity', service.title);
    const agency = field('Agencia/Proveedor', 'Agency/Provider', service.providerBoughtName);
    const reference = field('Referencia', 'Reference', service.providerFinalReference);
    const meetingPoint = field('Punto de encuentro', 'Meeting point', service.activityMeetingPoint);

    if (service.type === 'transfer') {
        return variant.kind === 'ida'
            ? [date, hour, airport, hotel, flight, client]
            : [date, hour, hotel, airport, client];
    }
    return variant.kind === 'con_recogida'
        ? [hotel, activity, client, agency, reference]
        : [agency, reference, activity, client, hour, meetingPoint];
}

// Replaces {{n}} with parameter n (like updateTemplateText in the frontend).
function renderTemplateText(body, parameters = []) {
    let finalText = String(body || '');
    parameters.forEach((value, index) => {
        const placeholder = `{{${index + 1}}}`;
        finalText = finalText.split(placeholder).join(value || placeholder);
    });
    return finalText;
}

function buildFallbackTextToDB(templateName, parameters) {
    return `**(Template ${templateName})**\n${parameters.join('\n')}`;
}

/**
 * Builds the confirmation template for the supplier (transfer or activity).
 * options.templateBody: body of the template in Meta, used to generate textToDB.
 */
function buildConfirmationWhatsappTemplate(service, reservation, options = {}) {
    if (!service) return { error: 'Servicio no encontrado' };
    if (!['transfer', 'activity'].includes(service.type)) {
        return { error: `Tipo de servicio sin plantilla de confirmación por WhatsApp: ${service.type || '-'}` };
    }
    const phoneTo = String(service.providerFinalPhone || '').trim();
    if (!phoneTo) return { error: 'El servicio no tiene teléfono del proveedor (providerFinalPhone)' };

    const lang = detectProviderLanguage({
        phone: phoneTo,
        timeZone: service.dateStartTimeZone,
        email: service.providerFinalEmail
    });
    const kind = service.type === 'transfer'
        ? (service.isTransferGo ? 'ida' : 'vuelta')
        : (service.activityMeetingPoint ? 'sin_recogida' : 'con_recogida');
    const templateName = service.type === 'transfer'
        ? `confirmar_traslado_${kind}_${lang}`
        : `actividad_${kind}_hotel_${lang}`;

    const fields = buildTemplateFields(service, { kind, lang });
    const missing = fields.filter(item => !String(item.value).trim()).map(item => item.labelEs);
    if (missing.length > 0) {
        return { error: `Faltan datos para la plantilla ${templateName}: ${missing.join(', ')}`, templateName };
    }

    const parameters = fields.map(item => String(item.value));
    const textToDB = options.templateBody
        ? renderTemplateText(options.templateBody, parameters)
        : buildFallbackTextToDB(templateName, parameters);
    return { templateName, lang, parameters, textToDB, phoneTo };
}

// Template bodies for the provider channel (same source as GET /whatsapp/templates/provider).
let templateCache = { at: 0, templates: null };
async function getProviderTemplates() {
    if (templateCache.templates && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) {
        return templateCache.templates;
    }
    const templates = await getWhatsapp().getTemplatesAvailable('provider');
    templateCache = { at: Date.now(), templates };
    return templates;
}

function findTemplate(templates, templateName, lang) {
    const matches = (templates || []).filter(item => item.name === templateName);
    return matches.find(item => String(item.lang || '').startsWith(lang)) || matches[0] || null;
}

function toObjectId(value) {
    if (!value) return undefined;
    const id = value._id || value;
    return mongoose.Types.ObjectId.isValid(String(id)) ? id : undefined;
}

function describeSendError(error) {
    const diagnostic = (error && error.whatsappSendDiagnostics) || {};
    const metaCode = diagnostic.metaCode || null;
    const detail = diagnostic.metaMessage || (error && error.message) || 'error desconocido';
    return {
        metaCode,
        reason: `Error al enviar WhatsApp al proveedor${metaCode ? ` (Meta ${metaCode})` : ''}: ${detail}`
    };
}

/**
 * Sends the confirmation template to the supplier through the 'provider' channel
 * (same path as POST /whatsapp/send/provider) and links the message to the task.
 */
async function sendConfirmationWhatsapp({ task, service, reservation }) {
    const built = buildConfirmationWhatsappTemplate(service, reservation);
    if (built.error) return { sent: false, reason: built.error };

    let template = null;
    try {
        const templates = await getProviderTemplates();
        template = findTemplate(templates, built.templateName, built.lang);
        if (!template) return { sent: false, reason: `La plantilla ${built.templateName} no existe en Meta` };
    } catch (error) {
        // No access to the templates (e.g. development): it is sent anyway with fallback text.
        console.warn('[AUTO TASK WHATSAPP] No se pudieron obtener las plantillas:', error && error.message);
    }

    let parameters = built.parameters;
    let textToDB = built.textToDB;
    let lang = built.lang;
    if (template) {
        const numberOfComponents = Number(template.numberOfComponents) || 0;
        if (numberOfComponents > parameters.length) {
            return { sent: false, reason: `La plantilla ${built.templateName} espera ${numberOfComponents} variables y solo hay ${parameters.length}` };
        }
        // The frontend only sends as many values as the template has variables.
        if (numberOfComponents > 0) parameters = parameters.slice(0, numberOfComponents);
        textToDB = renderTemplateText(template.text, parameters);
        lang = template.lang || lang;
    }

    try {
        const message = await getWhatsapp().sendMessage({
            phoneTo: built.phoneTo,
            type: 'template',
            templateName: built.templateName,
            parameters,
            lang,
            textToDB,
            fromType: 'provider'
        }, { notifyAdminOnFailure: false }, {
            autoTaskId: toObjectId(task),
            serviceReservationId: toObjectId(service),
            reservationId: toObjectId(reservation) || toObjectId(task && task.reservationId)
        });
        return { sent: true, messageId: message && message.id, phoneTo: built.phoneTo, templateName: built.templateName, textToDB };
    } catch (error) {
        const { reason, metaCode } = describeSendError(error);
        return { sent: false, reason, metaCode };
    }
}

// Prevents the appended block from confusing the Telegram -> WhatsApp reply in the admin notification module.
function sanitizeTelegramText(value) {
    return String(value || '')
        .replace(/Tel[ée]fono:/gi, 'Tel.')
        .replace(/WhatsApp ID:/gi, 'WhatsApp ID')
        .replace(/\*\*(Cliente|Proveedor)\*\*/gi, '$1');
}

function truncate(value, maxLength) {
    const text = String(value || '').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function formatSentAt(date) {
    return date ? moment(date).tz(TIMEZONE).format('DD/MM HH:mm') : '-';
}

function buildReservationLine(service, reservation) {
    if (!service && !reservation) return '';
    const reservationName = reservation && (reservation.title || reservation.clientsNames);
    const serviceDate = service ? [service.dateStart, service.dateStartHour].filter(Boolean).join(' ') : '';
    const parts = [reservationName || '-', service && service.title, serviceDate].filter(Boolean);
    return `Reserva: ${parts.join(' · ')}`;
}

/**
 * Formats the context block (pure).
 * mode: 'reply' (specific message), 'pending' (several tasks) or 'last' (last one sent).
 * entries: [{ sentAt, service, reservation, text }]
 */
function formatProviderReplyContextBlock({ mode, entries = [], maxTextLength = DEFAULT_QUOTE_LENGTH }) {
    if (!entries.length) return '';
    let lines;
    if (mode === 'pending') {
        lines = [
            '↪️ Varias confirmaciones pendientes con este proveedor:',
            ...entries.slice(0, MAX_PENDING_LISTED).map(entry =>
                `• ${buildReservationLine(entry.service, entry.reservation) || 'Reserva: -'} (enviado ${formatSentAt(entry.sentAt)})`)
        ];
    } else {
        const entry = entries[0];
        const header = mode === 'last'
            ? `↪️ Último mensaje enviado (${formatSentAt(entry.sentAt)}):`
            : `↪️ En respuesta a (enviado ${formatSentAt(entry.sentAt)}):`;
        const reservationLine = buildReservationLine(entry.service, entry.reservation);
        lines = [header];
        if (reservationLine) lines.push(reservationLine);
        if (entry.text) lines.push(`"${truncate(entry.text, maxTextLength)}"`);
    }
    return `\n\n${lines.map(sanitizeTelegramText).join('\n')}`;
}

async function loadEntry(message, task) {
    const { ServiceReservation, Reservation } = getModels();
    const serviceId = message.serviceReservationId || (task && task.serviceId);
    const reservationId = message.reservationId || (task && task.reservationId);
    const [service, reservation] = await Promise.all([
        serviceId ? ServiceReservation.findById(serviceId).select('title dateStart dateStartHour').lean() : null,
        reservationId ? Reservation.findById(reservationId).select('title clientsNames').lean() : null
    ]);
    return { sentAt: message.timestamp, service, reservation, text: message.text };
}

/**
 * Context for Telegram when a supplier replies: which message/task they are replying to.
 * Returns '' if there is nothing useful to add.
 */
async function buildProviderReplyContext({ contextMessageId, whatsappContactId, contactIdentifiers = [], maxTextLength } = {}) {
    const { WhatsappMessage, AutoTaskReservation } = getModels();

    if (contextMessageId) {
        const quoted = await WhatsappMessage.findOne({ id: String(contextMessageId), direction: 'outbound' }).lean();
        if (quoted) {
            const task = quoted.autoTaskId ? await AutoTaskReservation.findById(quoted.autoTaskId).lean() : null;
            return formatProviderReplyContextBlock({ mode: 'reply', entries: [await loadEntry(quoted, task)], maxTextLength });
        }
    }

    const contactConditions = [];
    if (whatsappContactId) contactConditions.push({ whatsappContactId });
    const identifiers = contactIdentifiers.filter(Boolean);
    if (identifiers.length) contactConditions.push({ to: { $in: identifiers } });
    if (!contactConditions.length) return '';

    const baseQuery = {
        direction: 'outbound',
        $or: contactConditions,
        timestamp: { $gte: new Date(Date.now() - CONTEXT_LOOKBACK_MS) }
    };

    // Confirmations sent by auto tasks that are still open.
    const taskMessages = await WhatsappMessage.find({ ...baseQuery, autoTaskId: { $exists: true, $ne: null } })
        .sort({ timestamp: -1 }).limit(50).lean();
    if (taskMessages.length) {
        const taskIds = [...new Set(taskMessages.map(item => String(item.autoTaskId)))];
        const openTasks = await AutoTaskReservation.find({ _id: { $in: taskIds }, isDone: false }).lean();
        const openById = new Map(openTasks.map(item => [String(item._id), item]));
        const seen = new Set();
        const pending = taskMessages.filter(item => {
            const key = String(item.autoTaskId);
            if (!openById.has(key) || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        if (pending.length === 1) {
            const entry = await loadEntry(pending[0], openById.get(String(pending[0].autoTaskId)));
            return formatProviderReplyContextBlock({ mode: 'reply', entries: [entry], maxTextLength });
        }
        if (pending.length > 1) {
            const entries = await Promise.all(pending.slice(0, MAX_PENDING_LISTED)
                .map(item => loadEntry(item, openById.get(String(item.autoTaskId)))));
            return formatProviderReplyContextBlock({ mode: 'pending', entries, maxTextLength });
        }
    }

    // Last message sent to the contact (not counting generic auto replies).
    const last = await WhatsappMessage.findOne({
        ...baseQuery,
        text: { $not: /^\*\*\(Auto respuesta/ },
        automationKind: { $nin: AUTO_REPLY_KINDS }
    })
        .sort({ timestamp: -1 }).lean();
    if (!last) return '';
    return formatProviderReplyContextBlock({
        mode: 'last',
        entries: [{ sentAt: last.timestamp, text: last.text }],
        maxTextLength
    });
}

function buildFailureReason(failureCode, failureTitle) {
    const detail = [failureCode, failureTitle].filter(Boolean).join(' - ') || 'sin código';
    return `WhatsApp no entregado al proveedor (${detail}): contactar por otra vía`;
}

/**
 * Asynchronous delivery failure (status webhook): the task goes back to manual and urgent.
 */
async function onAutoTaskWhatsappFailed({ autoTaskId, messageId, failureCode, failureTitle }) {
    if (!autoTaskId) return null;
    const { AutoTaskReservation, ServiceReservation, Reservation } = getModels();
    const reason = buildFailureReason(failureCode, failureTitle);
    const now = new Date();
    const task = await AutoTaskReservation.findByIdAndUpdate(autoTaskId, {
        $set: {
            isUrgent: true,
            isDone: false,
            'automation.status': 'manual',
            'automation.reason': reason,
            'automation.decidedAt': now
        },
        $push: { 'automation.log': { at: now, action: 'manual', detail: `${reason} (mensaje ${messageId || '-'})` } }
    }, { returnDocument: 'after' }).lean();
    if (!task) return null;

    const [service, reservation] = await Promise.all([
        task.serviceId ? ServiceReservation.findById(task.serviceId).select('title dateStart dateStartHour providerFinalPhone').lean() : null,
        task.reservationId ? Reservation.findById(task.reservationId).select('title clientsNames').lean() : null
    ]);
    const lines = [
        '---',
        '🚨 WhatsApp de confirmación NO entregado al proveedor',
        '',
        buildReservationLine(service, reservation) || 'Reserva: -',
        // 'Tel.' instead of 'Teléfono:' so that a reply in Telegram is not forwarded to that WhatsApp.
        service && service.providerFinalPhone ? `Tel. proveedor ${service.providerFinalPhone}` : null,
        `Error: ${[failureCode, failureTitle].filter(Boolean).join(' - ') || '-'}`,
        '',
        'Tarea marcada como urgente: contactar al proveedor por otra vía.'
    ].filter(line => line !== null);
    getNotificationAdmin().sendNotificationAdmin(lines.map(sanitizeTelegramText).join('\n'), true, false, null, null, {}, false);
    return task;
}

module.exports = {
    buildConfirmationWhatsappTemplate,
    buildFailureReason,
    buildProviderReplyContext,
    formatDateNatural,
    formatProviderReplyContextBlock,
    isSpanishSpeakingCountry,
    onAutoTaskWhatsappFailed,
    renderTemplateText,
    sanitizeTelegramText,
    sendConfirmationWhatsapp
};
