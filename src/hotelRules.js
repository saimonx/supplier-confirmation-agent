'use strict';

const moment = require('moment-timezone');
const {
    extractEmailAddress,
    getEmailDomain,
    isHardBounce
} = require('./gmailMessageNormalizer');
const { detectProviderLanguage } = require('./language');

// Pure rules for automatic hotel confirmation: email template,
// reply/bounce lookup and validation of AI results.
// No access to the database, Gmail or OpenAI.

// ---------------------------------------------------------------------------
// hotel_confirmation_es / hotel_confirmation_en template
// Exact port of the back-office panel logic: email templates,
// auto task completion dialog (hotelTemplateData) and email sending (signature).
// ---------------------------------------------------------------------------

const HOTEL_CONFIRMATION_SUBJECTS = {
    es: 'Confirmacion de reserva de hotel',
    en: 'Hotel reservation confirmation request'
};

const HOTEL_REGIMES = {
    es: { SA: 'Solo alojamiento', AD: 'Desayuno incluido', MP: 'Media pensión', PC: 'Pensión completa', TI: 'Todo incluido' },
    en: { SA: 'Room only', AD: 'Breakfast included', MP: 'Half board', PC: 'Full board', TI: 'All inclusive' }
};

const HOTEL_EMAIL_SIGNATURE = `
		<br><br>
		<p>NomadFlight &middot; bookings@example.com &middot; nomadflight.com</p>
		`;

/**
 * Language of the email to the hotel: hotel time zone, phone with "+" or email domain.
 * See reservationAutoTaskLanguage.detectProviderLanguage.
 */
function detectHotelEmailLanguage(providerPhone, { timeZone, email } = {}) {
    return detectProviderLanguage({ phone: providerPhone, timeZone, email });
}

// DD/MM/YYYY → YYYY-MM-DD (convertDateToISO in the back-office panel)
function convertDateToISO(dateStr) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('/');
    if (parts.length !== 3) return String(dateStr);
    return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
}

function getHotelRegimeDescription(regime, language) {
    if (!regime) return null;
    const regimeMap = language === 'es' ? HOTEL_REGIMES.es : HOTEL_REGIMES.en;
    return regimeMap[regime] || regime;
}

function getNumberOfPeopleForRoom(room, language) {
    const adults = room.adults || 0;
    const children = room.children || 0;
    if (adults + children === 0) return null;

    let result = '';
    if (language === 'es') {
        if (adults > 0) result += `${adults} adulto${adults > 1 ? 's' : ''}`;
        if (children > 0) {
            if (result) result += ', ';
            result += `${children} niño${children > 1 ? 's' : ''}`;
        }
    } else {
        if (adults > 0) result += `${adults} adult${adults > 1 ? 's' : ''}`;
        if (children > 0) {
            if (result) result += ', ';
            result += `${children} child${children > 1 ? 'ren' : ''}`;
        }
    }
    return result;
}

function formatLocalizedMomentDate(date, language, includeYear = false) {
    const day = date.date();
    const year = date.year();
    const monthDate = new Date(Date.UTC(2020, date.month(), 1));
    const locale = language === 'es' ? 'es-ES' : 'en-US';
    const month = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(monthDate);

    if (language === 'es') {
        return includeYear ? `${day} de ${month} del ${year}` : `${day} de ${month}`;
    }

    const remainder = day % 100;
    const lastDigit = day % 10;
    let ordinalSuffix = 'th';
    if (remainder < 11 || remainder > 13) {
        if (lastDigit === 1) ordinalSuffix = 'st';
        if (lastDigit === 2) ordinalSuffix = 'nd';
        if (lastDigit === 3) ordinalSuffix = 'rd';
    }
    const formattedDay = `${day}${ordinalSuffix}`;
    return includeYear ? `${month} ${formattedDay} ${year}` : `${month} ${formattedDay}`;
}

function formatDateForEmail(dateStr, language) {
    if (!dateStr) return '';
    const date = moment(dateStr, 'YYYY-MM-DD');
    if (!date.isValid()) return dateStr;
    return formatLocalizedMomentDate(date, language, true);
}

function shiftDate(dateStr, days, language) {
    if (!dateStr) return '';
    const date = moment(dateStr, 'YYYY-MM-DD');
    if (!date.isValid()) return dateStr;
    return formatLocalizedMomentDate(date.add(days, 'day'), language);
}

function escapeHtmlText(message) {
    return escapeCustomMessage(String(message || ''));
}

function escapeCustomMessage(message) {
    return message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\r?\n/g, '<br>');
}

function formatCustomMessage(message) {
    if (!message || !message.trim()) return '';
    return `<p><strong>${escapeCustomMessage(message.trim())}</strong></p><br>`;
}

function getGuestsContext(reservation, language) {
    const guestsCount = Number((reservation && reservation.adults) || 0) +
        Number((reservation && reservation.children) || 0) +
        Number((reservation && reservation.infants) || 0);
    const isSingleGuest = guestsCount === 1;
    if (language === 'es') {
        return { label: isSingleGuest ? 'el cliente' : 'los clientes', verbSuffix: isSingleGuest ? '' : 'n' };
    }
    return { label: isSingleGuest ? 'the client' : 'the clients', verbSuffix: '' };
}

function getDefaultEarlyCheckinMessage(checkinDate, reservation, language) {
    const arrivalDate = shiftDate(checkinDate, 1, language);
    const guests = getGuestsContext(reservation, language);
    if (language === 'es') {
        return arrivalDate
            ? `La primera noche está reservada como early check-in y ${guests.label} llegará${guests.verbSuffix} el día ${arrivalDate}.`
            : 'La primera noche está reservada como early check-in.';
    }
    return arrivalDate
        ? `The first night is booked as early check-in and ${guests.label} will arrive on ${arrivalDate}.`
        : 'The first night is booked as early check-in.';
}

function getDefaultLateCheckoutMessage(checkoutDate, reservation, language) {
    const departureDate = shiftDate(checkoutDate, -1, language);
    const guests = getGuestsContext(reservation, language);
    if (language === 'es') {
        return departureDate
            ? `La última noche está reservada como late check-out y ${guests.label} saldrá${guests.verbSuffix} del hotel el día ${departureDate}.`
            : 'La última noche está reservada como late check-out.';
    }
    return departureDate
        ? `The last night is booked as late check-out and ${guests.label} will leave the hotel on ${departureDate}.`
        : 'The last night is booked as late check-out.';
}

function getEarlyLateMessage({ early, late, earlyText, lateText, language }) {
    if (early && late) {
        const earlyMessage = escapeCustomMessage(earlyText.trim()).replace(/[.!?]+$/g, '');
        const escapedLate = escapeCustomMessage(lateText.trim());
        const lateMessage = escapedLate.charAt(0).toLocaleLowerCase(language) + escapedLate.slice(1);
        const connector = language === 'es' ? ' y también ' : ' and also ';
        return `<p><strong>${earlyMessage}${connector}${lateMessage}</strong></p><br>`;
    }
    if (early) return formatCustomMessage(earlyText);
    if (late) return formatCustomMessage(lateText);
    return '';
}

function getHoneymoonMessage(includeHoneymoon, language) {
    if (!includeHoneymoon) return '';
    return language === 'es'
        ? '<p>Quiero informarle que están en su luna de miel recién casados. ¿Pueden preparar algo especial para ellos?</p><br>'
        : '<p>I want to inform you that they are honeymooners just married. Can you prepare something special for them?</p><br>';
}

function getBedPreferenceMessage(reservation, numberOfRooms, language) {
    // Preference selected by default in the back-office panel (only with one room and a king/twin value)
    let selectedBedPreference = '';
    if (numberOfRooms === 1 && reservation && reservation.bedPreference && String(reservation.bedPreference).trim() !== '') {
        const originalValue = String(reservation.bedPreference).toLowerCase();
        if (['king', 'twin'].includes(originalValue)) {
            selectedBedPreference = originalValue;
        }
    }

    // Same condition as the back-office panel (direct numeric sum of the reservation's travelers)
    if (numberOfRooms === 1 &&
        reservation &&
        (reservation.adults + reservation.children + reservation.infants) <= 2 &&
        reservation.bedPreference &&
        selectedBedPreference) {
        let bedText = '';
        if (selectedBedPreference === 'king') {
            bedText = language === 'es' ? '1 cama king size' : '1 king size bed';
        } else if (selectedBedPreference === 'twin') {
            bedText = language === 'es' ? '2 camas individuales' : '2 twin beds';
        }
        if (bedText) {
            return language === 'es'
                ? `<p><strong>Por favor asignen ${bedText} para esta habitación.</strong></p><br>`
                : `<p><strong>Please assign ${bedText} for this room.</strong></p><br>`;
        }
    }
    return '';
}

function generateTemplateHTML(isSpanish, numberOfRooms) {
    const isMultipleRooms = numberOfRooms > 1;
    let roomsSection = '';
    for (let i = 1; i <= numberOfRooms; i++) {
        if (isMultipleRooms) {
            roomsSection += isSpanish
                ? `<p><strong><u>Habitación ${i}:</u></strong><br>`
                : `<p><strong><u>Room ${i}:</u></strong><br>`;
        } else {
            roomsSection += '<p>';
        }
        if (isSpanish) {
            roomsSection += `<strong>Cliente:</strong> {{clientName${i}}}<br>`;
            roomsSection += `<strong>Habitación:</strong> {{roomType${i}}}<br>`;
            roomsSection += `<strong>Régimen:</strong> {{regime${i}}}<br>`;
            roomsSection += `<strong>Personas:</strong> {{people${i}}}</p>`;
        } else {
            roomsSection += `<strong>Client:</strong> {{clientName${i}}}<br>`;
            roomsSection += `<strong>Room:</strong> {{roomType${i}}}<br>`;
            roomsSection += `<strong>Board basis:</strong> {{regime${i}}}<br>`;
            roomsSection += `<strong>People:</strong> {{people${i}}}</p>`;
        }
    }

    if (isSpanish) {
        return `
				<p>Hola.</p>

				<p>Mi nombre es Jose Simon, de la agencia de viajes española NomadFlight.</p>

				<p>Tenemos {{reservationText}} en <strong>{{hotelName}}</strong>:</p>

				<br>
				<p><strong>Check-in:</strong> {{checkinDate}}<br>
				<strong>Check-out:</strong> {{checkoutDate}}</p>

				${roomsSection}
				<br>

				{{honeymoonMessage}}

				{{earlyLateMessage}}

				{{bedPreferenceMessage}}

				<p>{{confirmationPrefix}}{{confirmationText}}</p><br>

				<p>Quedo a la espera de su respuesta.</p><br>

				<p>Gracias,<br>
				Saludos cordiales.</p>
			`;
    }
    return `
				<p>Hello.</p>

				<p>My name is Jose Simon, from the Spanish travel agency NomadFlight.</p>

				<p>We have {{reservationText}} at <strong>{{hotelName}}</strong>:</p>

				<br>
				<p><strong>Check-in:</strong> {{checkinDate}}<br>
				<strong>Check-out:</strong> {{checkoutDate}}</p>

				${roomsSection}
				<br>

				{{honeymoonMessage}}

				{{earlyLateMessage}}

				{{bedPreferenceMessage}}

				<p>{{confirmationPrefix}}{{confirmationText}}</p><br>

				<p>Waiting for your reply.</p><br>

				<p>Thank you,<br>
				Best regards.</p>
			`;
}

/**
 * Builds the hotel confirmation email exactly as the back-office panel does (template + signature).
 * Does not add supplier references: the back-office panel's hotel template does not include them.
 * @returns {{subject: string, html: string, lang: string}|{error: string, missingFields?: string[]}}
 */
function buildHotelConfirmationEmail({ service, reservation } = {}) {
    if (!service || service.type !== 'hotel') {
        return { error: 'service_not_hotel' };
    }
    const reservationData = reservation || {};
    const lang = detectHotelEmailLanguage(service.providerFinalPhone, {
        timeZone: service.dateStartTimeZone,
        email: service.providerFinalEmail
    });
    const isSpanish = lang === 'es';
    const rooms = Array.isArray(service.hotelRooms) ? service.hotelRooms : [];

    if (rooms.length === 0) {
        // In the back-office panel the placeholders would be left unfilled and sending would be blocked
        return { error: 'hotel_rooms_missing', missingFields: ['hotelRooms'] };
    }

    const numberOfRooms = rooms.length;
    const isMultipleRooms = numberOfRooms > 1;
    const checkinISO = convertDateToISO(service.dateStart);
    const checkoutISO = convertDateToISO(service.dateEnd);

    // Field values and unconfigured fields (in the back-office panel they block sending)
    const values = {
        hotelName: service.title || '',
        checkinDate: checkinISO,
        checkoutDate: checkoutISO
    };
    rooms.forEach((room, index) => {
        const roomNumber = index + 1;
        values[`clientName${roomNumber}`] = room.fullClientName || '';
        values[`roomType${roomNumber}`] = room.roomName || '';
        values[`regime${roomNumber}`] = getHotelRegimeDescription(room.hotelRegime, lang) || '';
        values[`people${roomNumber}`] = getNumberOfPeopleForRoom(room, lang) || '';
    });

    const missingFields = Object.keys(values).filter(key => !values[key] || String(values[key]).trim() === '');
    if (!service.dateStart && !missingFields.includes('checkinDate')) missingFields.push('checkinDate');
    if (!service.dateEnd && !missingFields.includes('checkoutDate')) missingFields.push('checkoutDate');
    if (missingFields.length > 0) {
        return { error: 'hotel_template_missing_fields', missingFields };
    }

    // Dates are displayed formatted from the YYYY-MM-DD value
    const fieldValues = Object.assign({}, values, {
        checkinDate: /^\d{4}-\d{2}-\d{2}$/.test(checkinISO) ? formatDateForEmail(checkinISO, lang) : checkinISO,
        checkoutDate: /^\d{4}-\d{2}-\d{2}$/.test(checkoutISO) ? formatDateForEmail(checkoutISO, lang) : checkoutISO
    });

    const early = service.hotelFirstNightAsEarlyCheckIn === true;
    const late = service.hotelLastNightAsLateCheckOut === true;
    const earlyText = getDefaultEarlyCheckinMessage(checkinISO, reservationData, lang);
    const lateText = getDefaultLateCheckoutMessage(checkoutISO, reservationData, lang);
    const includeHoneymoon = reservationData.honeyMoonPreference === 'yes';
    const honeymoonMessage = getHoneymoonMessage(includeHoneymoon, lang);
    const confirmationPrefix = honeymoonMessage !== '' ? (isSpanish ? 'También, ' : 'Also, ') : '';
    const plural = numberOfRooms > 1;
    let confirmationText;
    if (isSpanish) {
        confirmationText = (confirmationPrefix ? '¿pueden' : '¿Pueden') +
            ' confirmarnos todos los detalles de la' + (plural ? 's reservas?' : ' reserva?');
    } else {
        confirmationText = (confirmationPrefix ? 'can' : 'Can') +
            ' you confirm all details of the ' + (plural ? 'reservations?' : 'reservation?');
    }
    const reservationText = isSpanish
        ? (isMultipleRooms ? 'las siguientes reservas' : 'la siguiente reserva')
        : (isMultipleRooms ? 'the following reservations' : 'the following reservation');

    let content = generateTemplateHTML(isSpanish, numberOfRooms);
    Object.keys(fieldValues).forEach(key => {
        content = content.split(`{{${key}}}`).join(String(fieldValues[key]));
    });
    content = content
        .split('{{reservationText}}').join(reservationText)
        .split('{{honeymoonMessage}}').join(honeymoonMessage)
        .split('{{earlyLateMessage}}').join(getEarlyLateMessage({ early, late, earlyText, lateText, language: lang }))
        .split('{{bedPreferenceMessage}}').join(getBedPreferenceMessage(reservationData, numberOfRooms, lang))
        .split('{{confirmationPrefix}}').join(confirmationPrefix)
        .split('{{confirmationText}}').join(confirmationText);

    return {
        subject: HOTEL_CONFIRMATION_SUBJECTS[lang],
        html: content + HOTEL_EMAIL_SIGNATURE,
        lang
    };
}

// ---------------------------------------------------------------------------
// Reply and bounce lookup
// ---------------------------------------------------------------------------

// Margin for clock skew between our send record and Gmail
const FOLLOW_UP_CLOCK_SKEW_MS = 5 * 60 * 1000;

const GENERIC_EMAIL_DOMAINS = [
    'gmail.com', 'googlemail.com', 'icloud.com', 'me.com', 'mac.com', 'msn.com', 'aol.com',
    'ymail.com', 'rocketmail.com', 'proton.me', 'protonmail.com', 'pm.me', 'mail.com', 'email.com',
    'zoho.com', 'qq.com', '163.com', '126.com', 'mail.ru', 'web.de', 'orange.fr', 'wanadoo.fr',
    'free.fr', 'laposte.net', 'libero.it', 'virgilio.it', 'tiscali.it', 'telefonica.net',
    'movistar.es', 'terra.es', 'naver.com', 'daum.net', 'rediffmail.com', 'fastmail.com', 'tutanota.com'
];
// Providers with per-country variants (hotmail.es, outlook.fr, yahoo.co.uk, live.com.mx...)
const GENERIC_EMAIL_DOMAIN_PREFIXES = ['hotmail', 'outlook', 'live', 'yahoo', 'gmx', 'yandex', 'aol', 'windowslive'];

function isGenericEmailDomain(domain) {
    const normalized = String(domain || '').trim().toLowerCase().replace(/^@/, '');
    if (!normalized) return true;
    if (GENERIC_EMAIL_DOMAINS.includes(normalized)) return true;
    const firstLabel = normalized.split('.')[0];
    return GENERIC_EMAIL_DOMAIN_PREFIXES.includes(firstLabel);
}

function toEpochSeconds(date) {
    return Math.floor((new Date(date).getTime() - FOLLOW_UP_CLOCK_SKEW_MS) / 1000);
}

/**
 * Gmail queries to find bounces and replies outside the thread.
 * @returns {{bounceQuery: string, senderQuery: string|null, domainQuery: string|null}}
 */
function buildFollowUpSearchQueries({ sentTo, sentAt, ownDomains = ['nomadflight.com'] }) {
    const after = toEpochSeconds(sentAt);
    const recipient = extractEmailAddress(sentTo);
    const domain = getEmailDomain(recipient);
    const useDomain = domain && !isGenericEmailDomain(domain) && !ownDomains.includes(domain);
    return {
        bounceQuery: `from:(mailer-daemon OR postmaster) after:${after}`,
        senderQuery: recipient ? `from:${recipient} after:${after}` : null,
        domainQuery: useDomain ? `from:@${domain} after:${after}` : null
    };
}

function normalizeForMatch(text) {
    return String(text || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

// Terms that link an email to this reservation: lead travelers' surnames and references
function buildHotelMatchTerms({ service, reservation } = {}) {
    const terms = new Set();
    const rooms = (service && Array.isArray(service.hotelRooms)) ? service.hotelRooms : [];
    rooms.forEach(room => {
        const words = String(room.fullClientName || '').trim().split(/\s+/).filter(Boolean);
        // Surnames: every word except the first (given name), at least 3 letters long
        words.slice(1).forEach(word => {
            if (word.length >= 3) terms.add(normalizeForMatch(word));
        });
    });
    ['providerFinalReference', 'providerBoughtReference', 'hotelConfirmationNumber'].forEach(field => {
        const value = service && service[field] ? String(service[field]).trim() : '';
        if (value.length >= 4) terms.add(normalizeForMatch(value));
    });
    if (reservation && reservation.title && String(reservation.title).trim().length >= 4) {
        terms.add(normalizeForMatch(String(reservation.title).trim()));
    }
    return Array.from(terms);
}

function referencesRfcMessageId(message, rfcMessageId) {
    if (!message || !rfcMessageId) return false;
    const id = String(rfcMessageId).replace(/[<>]/g, '').trim().toLowerCase();
    if (!id) return false;
    return [message.inReplyTo, message.references, message.bounceSearchText]
        .some(value => value && String(value).toLowerCase().includes(id));
}

function messageMatchesTerms(message, terms) {
    if (!Array.isArray(terms) || terms.length === 0) return false;
    const haystack = normalizeForMatch(`${message.subject || ''}\n${message.textBody || ''}`);
    return terms.some(term => term && haystack.includes(term));
}

function bounceMatchesSend(message, { sentTo, rfcMessageId }) {
    const recipient = extractEmailAddress(sentTo);
    if (referencesRfcMessageId(message, rfcMessageId)) return true;
    if (recipient && message.bouncedRecipient === recipient) return true;
    return Boolean(recipient && message.bounceSearchText && message.bounceSearchText.toLowerCase().includes(recipient));
}

/**
 * Merges the messages from the thread and the searches and determines bounce and replies.
 * - Thread: messages after the send that are not ours.
 * - Bounces: in the thread, or in the mailbox if they cite the Message-ID or the recipient.
 * - Outside the thread: from the exact sender always; from the domain only if they cite our
 *   Message-ID or a reservation term (if there are any terms).
 * @returns {{bounce: {recipient: string, detail: string|null, messageId: string}|null, replies: object[]}}
 */
function selectHotelFollowUps({
    sentAt,
    sentTo,
    rfcMessageId = null,
    sentMessageId = null,
    threadMessages = [],
    bounceCandidates = [],
    senderMessages = [],
    domainMessages = [],
    matchTerms = []
}) {
    const sentAtMs = new Date(sentAt).getTime() - FOLLOW_UP_CLOCK_SKEW_MS;
    const recipient = extractEmailAddress(sentTo);
    const isAfterSend = message => Number(message.internalDate) >= sentAtMs;
    const seen = new Set();
    const bounces = [];
    const replies = [];

    const accept = (message, source) => {
        if (!message || !message.id || seen.has(message.id)) return;
        if (message.id === sentMessageId || message.isFromUs || !isAfterSend(message)) return;

        if (message.isBounce) {
            const inThread = source === 'thread';
            if (isHardBounce(message) && (inThread || bounceMatchesSend(message, { sentTo, rfcMessageId }))) {
                seen.add(message.id);
                bounces.push(message);
            }
            return;
        }

        if (source === 'bounce') return;
        if (source === 'domain' && matchTerms.length > 0 &&
            !referencesRfcMessageId(message, rfcMessageId) && !messageMatchesTerms(message, matchTerms)) {
            return;
        }
        seen.add(message.id);
        replies.push(message);
    };

    threadMessages.forEach(message => accept(message, 'thread'));
    bounceCandidates.forEach(message => accept(message, 'bounce'));
    senderMessages.forEach(message => accept(message, 'sender'));
    domainMessages.forEach(message => accept(message, 'domain'));

    bounces.sort((a, b) => a.internalDate - b.internalDate);
    replies.sort((a, b) => a.internalDate - b.internalDate);

    const firstBounce = bounces[0];
    return {
        bounce: firstBounce ? {
            recipient: firstBounce.bouncedRecipient || recipient || null,
            detail: firstBounce.bounceDetail || null,
            messageId: firstBounce.id
        } : null,
        replies
    };
}

// ---------------------------------------------------------------------------
// AI reply classification
// ---------------------------------------------------------------------------

const HOTEL_REPLY_CATEGORIES = ['confirmed_all', 'not_found', 'discrepancy', 'question', 'other'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

const HOTEL_REPLY_CLASSIFICATION_SCHEMA = {
    type: 'object',
    properties: {
        category: { type: 'string', enum: HOTEL_REPLY_CATEGORIES },
        confirmationNumber: { type: ['string', 'null'] },
        confirmedItems: { type: 'array', items: { type: 'string' } },
        differences: { type: 'array', items: { type: 'string' } },
        missingInfo: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
        summary: { type: 'string' }
    },
    required: ['category', 'confirmationNumber', 'confirmedItems', 'differences', 'missingInfo', 'confidence', 'summary'],
    additionalProperties: false
};

// Reservation data sent to the hotel, in a compact format for the AI
function buildHotelReservationFacts({ service, reservation } = {}) {
    const svc = service || {};
    const res = reservation || {};
    const rooms = Array.isArray(svc.hotelRooms) ? svc.hotelRooms : [];
    return {
        hotelName: svc.title || null,
        hotelAddress: svc.hotelAddress || null,
        checkIn: convertDateToISO(svc.dateStart) || null,
        checkOut: convertDateToISO(svc.dateEnd) || null,
        nights: svc.hotelNights || null,
        rooms: rooms.map((room, index) => ({
            room: index + 1,
            holder: room.fullClientName || null,
            roomType: room.roomName || null,
            regime: getHotelRegimeDescription(room.hotelRegime, 'es'),
            adults: room.adults || 0,
            children: room.children || 0
        })),
        travellers: {
            adults: res.adults || 0,
            children: res.children || 0,
            infants: res.infants || 0
        },
        earlyCheckIn: svc.hotelFirstNightAsEarlyCheckIn === true,
        lateCheckOut: svc.hotelLastNightAsLateCheckOut === true,
        specialRequests: {
            honeymoon: res.honeyMoonPreference === 'yes',
            bedPreference: res.bedPreference || null
        },
        references: {
            providerFinalReference: svc.providerFinalReference || null,
            providerBoughtReference: svc.providerBoughtReference || null
        }
    };
}

function normalizeStringArray(value) {
    return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
}

// Validates and normalizes the classifier output; any unexpected value degrades to 'other'/'low'
function normalizeHotelReplyClassification(raw) {
    const result = raw && typeof raw === 'object' ? raw : {};
    const confirmationNumber = result.confirmationNumber ? String(result.confirmationNumber).trim() : '';
    return {
        category: HOTEL_REPLY_CATEGORIES.includes(result.category) ? result.category : 'other',
        confirmationNumber: confirmationNumber || null,
        confirmedItems: normalizeStringArray(result.confirmedItems),
        differences: normalizeStringArray(result.differences),
        missingInfo: normalizeStringArray(result.missingInfo),
        confidence: CONFIDENCE_LEVELS.includes(result.confidence) ? result.confidence : 'low',
        summary: String(result.summary || '').trim()
    };
}

// Only confirmed without an operator if the hotel confirms everything, with high confidence and no objections
function isSafeAutoConfirmation(result) {
    return Boolean(result) &&
        result.category === 'confirmed_all' &&
        result.confidence === 'high' &&
        Array.isArray(result.differences) && result.differences.length === 0 &&
        Array.isArray(result.missingInfo) && result.missingInfo.length === 0;
}

// ---------------------------------------------------------------------------
// Alternative hotel email found via web search
// ---------------------------------------------------------------------------

const ALTERNATIVE_HOTEL_EMAIL_SCHEMA = {
    type: 'object',
    properties: {
        email: { type: ['string', 'null'] },
        sourceUrl: { type: ['string', 'null'] },
        confidence: { type: 'string', enum: CONFIDENCE_LEVELS }
    },
    required: ['email', 'sourceUrl', 'confidence'],
    additionalProperties: false
};

// Domains that are never the hotel's email (agencies, intermediaries and our own)
const NON_HOTEL_EMAIL_DOMAINS = [
    'nomadflight.com', 'booking.com', 'guest.booking.com', 'expedia.com', 'hotels.com',
    'agoda.com', 'tripadvisor.com', 'trivago.com', 'airbnb.com', 'hotelbeds.com', 'example.com'
];

const STRICT_EMAIL_PATTERN = /^[A-Z0-9._%+'-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}$/i;

/**
 * Validates the email proposed by the AI. Returns null if it is not usable.
 * @returns {{email: string, sourceUrl: string|null, confidence: string}|null}
 */
function validateAlternativeHotelEmail(raw, excludeEmails = []) {
    if (!raw || typeof raw !== 'object' || !raw.email) return null;
    const email = String(raw.email).trim().toLowerCase().replace(/^mailto:/, '');
    if (!STRICT_EMAIL_PATTERN.test(email)) return null;
    if (!CONFIDENCE_LEVELS.includes(raw.confidence) || raw.confidence === 'low') return null;

    const excluded = (excludeEmails || []).map(item => extractEmailAddress(item)).filter(Boolean);
    if (excluded.includes(email)) return null;

    const domain = getEmailDomain(email);
    if (NON_HOTEL_EMAIL_DOMAINS.some(blocked => domain === blocked || domain.endsWith(`.${blocked}`))) return null;

    const sourceUrl = raw.sourceUrl && /^https?:\/\//i.test(String(raw.sourceUrl).trim())
        ? String(raw.sourceUrl).trim()
        : null;
    return { email, sourceUrl, confidence: raw.confidence };
}

module.exports = {
    HOTEL_CONFIRMATION_SUBJECTS,
    HOTEL_EMAIL_SIGNATURE,
    escapeHtmlText,
    HOTEL_REPLY_CATEGORIES,
    HOTEL_REPLY_CLASSIFICATION_SCHEMA,
    ALTERNATIVE_HOTEL_EMAIL_SCHEMA,
    detectHotelEmailLanguage,
    convertDateToISO,
    buildHotelConfirmationEmail,
    isGenericEmailDomain,
    buildFollowUpSearchQueries,
    buildHotelMatchTerms,
    referencesRfcMessageId,
    messageMatchesTerms,
    selectHotelFollowUps,
    buildHotelReservationFacts,
    normalizeHotelReplyClassification,
    isSafeAutoConfirmation,
    validateAlternativeHotelEmail
};
