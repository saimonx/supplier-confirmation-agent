const assert = require('assert');
const {
    normalizeGmailMessage,
    isHardBounce
} = require('../src/gmailMessageNormalizer');
const rules = require('../src/hotelRules');
const hotel = require('../src/hotelAgent');

// Offline tests: template, Gmail normalization, bounces, searches and classification with a mocked client.

function b64(text) {
    return Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const OUR = ['bookings@example.com', 'agent@example.com'];

async function main() {
    // ---------------------------------------------------------------------
    // Language
    // ---------------------------------------------------------------------
    assert.strictEqual(rules.detectHotelEmailLanguage(null), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage(' +34 950 000 000'), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage('+1809 555 1234'), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage('+1 212 555 1234'), 'en');
    assert.strictEqual(rules.detectHotelEmailLanguage('+66 2 000 0000'), 'en');
    // Without "+" or other data it is not recognized as Spanish-speaking
    assert.strictEqual(rules.detectHotelEmailLanguage('34950000000'), 'en');
    // The hotel's time zone takes precedence over the phone
    assert.strictEqual(rules.detectHotelEmailLanguage('02902 492970', { timeZone: 'America/Argentina/Rio_Gallegos' }), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage('1561086252', { timeZone: 'America/Cancun' }), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage('51-84-252330', { timeZone: 'America/Lima' }), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage('+552121956200', { timeZone: 'America/Sao_Paulo' }), 'en');
    assert.strictEqual(rules.detectHotelEmailLanguage(null, { timeZone: 'Pacific/Honolulu' }), 'en');
    // No time zone: email domain from a Spanish-speaking country
    assert.strictEqual(rules.detectHotelEmailLanguage('02902 492970', { email: 'hotel@example.com.ar' }), 'es');
    assert.strictEqual(rules.detectHotelEmailLanguage('02902 492970', { email: 'hotel@example.com' }), 'en');

    // ---------------------------------------------------------------------
    // Spanish template, one room, honeymoon and king bed
    // ---------------------------------------------------------------------
    const serviceEs = {
        type: 'hotel',
        title: 'Hotel Sol Cancún',
        dateStart: '05/11/2026',
        dateEnd: '12/11/2026',
        providerFinalPhone: '+52 998 000 0000',
        providerFinalEmail: 'reservas@hotelsol.example.mx',
        hotelRooms: [{ fullClientName: 'Ana Pérez López', roomName: 'Doble superior', hotelRegime: 'TI', adults: 2, children: 0 }]
    };
    const reservationEs = { adults: 2, children: 0, infants: 0, honeyMoonPreference: 'yes', bedPreference: 'King' };
    const es = hotel.buildHotelConfirmationEmail({ service: serviceEs, reservation: reservationEs });
    assert.strictEqual(es.lang, 'es');
    assert.strictEqual(es.subject, 'Confirmacion de reserva de hotel');
    assert.ok(es.html.includes('Tenemos la siguiente reserva en <strong>Hotel Sol Cancún</strong>'));
    assert.ok(es.html.includes('<strong>Check-in:</strong> 5 de noviembre del 2026'));
    assert.ok(es.html.includes('<strong>Check-out:</strong> 12 de noviembre del 2026'));
    assert.ok(es.html.includes('<strong>Cliente:</strong> Ana Pérez López<br>'));
    assert.ok(es.html.includes('<strong>Régimen:</strong> Todo incluido<br>'));
    assert.ok(es.html.includes('<strong>Personas:</strong> 2 adultos</p>'));
    assert.ok(es.html.includes('luna de miel'));
    assert.ok(es.html.includes('<p>También, ¿pueden confirmarnos todos los detalles de la reserva?</p>'));
    assert.ok(es.html.includes('Por favor asignen 1 cama king size para esta habitación.'));
    assert.ok(!es.html.includes('Habitación 1:'));
    assert.ok(!es.html.includes('{{'));
    assert.ok(es.html.includes('bookings@example.com'), 'incluye la firma');

    // ---------------------------------------------------------------------
    // English template, two rooms, early + late check-in
    // ---------------------------------------------------------------------
    const serviceEn = {
        type: 'hotel',
        title: 'Bangkok Riverside',
        dateStart: '01/12/2026',
        dateEnd: '04/12/2026',
        providerFinalPhone: '+66 2 000 0000',
        hotelFirstNightAsEarlyCheckIn: true,
        hotelLastNightAsLateCheckOut: true,
        hotelRooms: [
            { fullClientName: 'John Smith', roomName: 'Deluxe', hotelRegime: 'AD', adults: 2, children: 1 },
            { fullClientName: 'Mary Jones', roomName: 'Deluxe', hotelRegime: 'AD', adults: 1, children: 2 }
        ]
    };
    const reservationEn = { adults: 3, children: 3, infants: 0, honeyMoonPreference: 'no', bedPreference: 'king' };
    const en = hotel.buildHotelConfirmationEmail({ service: serviceEn, reservation: reservationEn });
    assert.strictEqual(en.lang, 'en');
    assert.strictEqual(en.subject, 'Hotel reservation confirmation request');
    assert.ok(en.html.includes('We have the following reservations at <strong>Bangkok Riverside</strong>'));
    assert.ok(en.html.includes('<strong>Check-in:</strong> December 1st 2026'));
    assert.ok(en.html.includes('<p><strong><u>Room 2:</u></strong><br>'));
    assert.ok(en.html.includes('<strong>People:</strong> 2 adults, 1 child</p>'));
    assert.ok(en.html.includes('<strong>People:</strong> 1 adult, 2 children</p>'));
    assert.ok(en.html.includes('<strong>Board basis:</strong> Breakfast included'));
    assert.ok(en.html.includes(
        '<p><strong>The first night is booked as early check-in and the clients will arrive on December 2nd and also the last night is booked as late check-out and the clients will leave the hotel on December 3rd.</strong></p>'
    ));
    assert.ok(en.html.includes('<p>Can you confirm all details of the reservations?</p>'));
    assert.ok(!en.html.includes('king size'), 'sin preferencia de cama con varias habitaciones');
    assert.ok(!en.html.includes('{{'));

    // Early check-in only, in Spanish, with a single traveler
    const earlyOnly = hotel.buildHotelConfirmationEmail({
        service: Object.assign({}, serviceEs, { hotelFirstNightAsEarlyCheckIn: true, providerFinalPhone: null }),
        reservation: { adults: 1, children: 0, infants: 0 }
    });
    assert.ok(earlyOnly.html.includes('<p><strong>La primera noche está reservada como early check-in y el cliente llegará el día 6 de noviembre.</strong></p><br>'));
    assert.ok(earlyOnly.html.includes('<p>¿Pueden confirmarnos todos los detalles de la reserva?</p>'));

    // Late check-out only, several travelers
    const lateOnly = hotel.buildHotelConfirmationEmail({
        service: Object.assign({}, serviceEs, { hotelLastNightAsLateCheckOut: true }),
        reservation: { adults: 2, children: 0, infants: 0 }
    });
    assert.ok(lateOnly.html.includes('los clientes saldrán del hotel el día 11 de noviembre.'));

    // Errors
    assert.deepStrictEqual(hotel.buildHotelConfirmationEmail({ service: { type: 'activity' } }), { error: 'service_not_hotel' });
    assert.strictEqual(hotel.buildHotelConfirmationEmail({ service: Object.assign({}, serviceEs, { hotelRooms: [] }) }).error, 'hotel_rooms_missing');
    const missing = hotel.buildHotelConfirmationEmail({
        service: Object.assign({}, serviceEs, { dateEnd: '', hotelRooms: [{ fullClientName: 'Ana', roomName: '', hotelRegime: 'AD', adults: 0 }] })
    });
    assert.strictEqual(missing.error, 'hotel_template_missing_fields');
    assert.deepStrictEqual(missing.missingFields.sort(), ['checkoutDate', 'people1', 'roomType1']);

    // ---------------------------------------------------------------------
    // Gmail message normalization and bounces
    // ---------------------------------------------------------------------
    const sentAt = new Date('2026-10-01T08:00:00.000Z');
    const t = minutes => String(sentAt.getTime() + minutes * 60000);

    const ourSent = normalizeGmailMessage({
        id: 'm-sent', threadId: 'th-1', internalDate: t(0), labelIds: ['SENT'],
        payload: {
            mimeType: 'text/html',
            headers: [
                { name: 'From', value: 'NomadFlight <bookings@example.com>' },
                { name: 'To', value: 'reservas@hotelsol.example.mx' },
                { name: 'Subject', value: 'Confirmacion de reserva de hotel' },
                { name: 'Message-ID', value: '<CAabc123@mail.gmail.com>' }
            ],
            body: { data: b64('<p>Hola.</p>') }
        }
    }, { ourEmails: OUR });
    assert.strictEqual(ourSent.isFromUs, true);
    assert.strictEqual(ourSent.isBounce, false);
    assert.strictEqual(ourSent.rfcMessageId, '<CAabc123@mail.gmail.com>');

    const cleanHistory = (content) => content.split(/\nEl .+ escribió:/)[0].trim();
    const hotelReply = normalizeGmailMessage({
        id: 'm-reply', threadId: 'th-1', internalDate: t(60), labelIds: ['INBOX'],
        payload: {
            mimeType: 'multipart/alternative',
            headers: [
                { name: 'From', value: '"Reservas Hotel Sol" <Reservas@HotelSol.example.mx>' },
                { name: 'Subject', value: 'RE: Confirmacion de reserva de hotel' },
                { name: 'In-Reply-To', value: '<CAabc123@mail.gmail.com>' }
            ],
            parts: [
                { mimeType: 'text/plain', body: { data: b64('Confirmada, número 778899.\nEl 1 oct 2026, NomadFlight escribió:\n> Hola.') } },
                { mimeType: 'text/html', body: { data: b64('<p>Confirmada, número 778899.</p>') } }
            ]
        }
    }, { ourEmails: OUR, cleanHistory });
    assert.strictEqual(hotelReply.fromEmail, 'reservas@hotelsol.example.mx');
    assert.strictEqual(hotelReply.isFromUs, false);
    assert.strictEqual(hotelReply.textBody, 'Confirmada, número 778899.');
    assert.ok(hotelReply.date instanceof Date);

    // HTML-only reply
    const htmlOnly = normalizeGmailMessage({
        id: 'm-html', internalDate: t(5),
        payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'front@hotelsol.example.mx' }], body: { data: b64('<div>Hola&nbsp;<b>equipo</b><br>Gracias</div>') } }
    }, { ourEmails: OUR });
    assert.strictEqual(htmlOnly.textBody, 'Hola equipo\nGracias');

    // Standard DSN (RFC 3464) with recipient and diagnostic
    const dsnPayload = {
        mimeType: 'multipart/report',
        headers: [
            { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
            { name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary="x"' },
            { name: 'Subject', value: 'Delivery Status Notification (Failure)' }
        ],
        parts: [
            { mimeType: 'text/plain', body: { data: b64('Your message wasn\'t delivered to reservas@hotelsol.example.mx because the address couldn\'t be found.') } },
            {
                mimeType: 'message/delivery-status',
                body: { data: b64('Reporting-MTA: dns; googlemail.com\n\nFinal-Recipient: rfc822; reservas@hotelsol.example.mx\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown\n  in virtual mailbox table') }
            },
            {
                mimeType: 'text/rfc822-headers',
                body: { data: b64('Message-ID: <CAabc123@mail.gmail.com>\nSubject: Confirmacion de reserva de hotel') }
            }
        ]
    };
    const dsn = normalizeGmailMessage({ id: 'm-dsn', threadId: 'th-1', internalDate: t(2), payload: dsnPayload }, { ourEmails: OUR });
    assert.strictEqual(dsn.isBounce, true);
    assert.strictEqual(dsn.isFromUs, false);
    assert.strictEqual(dsn.bouncedRecipient, 'reservas@hotelsol.example.mx');
    assert.strictEqual(dsn.bounceAction, 'failed');
    assert.strictEqual(dsn.bounceStatus, '5.1.1');
    assert.strictEqual(dsn.bounceDetail, '550 5.1.1 User unknown in virtual mailbox table');
    assert.strictEqual(isHardBounce(dsn), true);
    assert.ok(rules.referencesRfcMessageId(dsn, '<CAabc123@mail.gmail.com>'));

    // Bounce with X-Failed-Recipients and no delivery-status part
    const xfailed = normalizeGmailMessage({
        id: 'm-xf', internalDate: t(3),
        payload: {
            mimeType: 'text/plain',
            headers: [
                { name: 'From', value: 'postmaster@hotelsol.example.mx' },
                { name: 'X-Failed-Recipients', value: 'Reservas@hotelsol.example.mx' }
            ],
            body: { data: b64('Delivery has failed to these recipients.') }
        }
    }, { ourEmails: OUR });
    assert.strictEqual(xfailed.isBounce, true);
    assert.strictEqual(xfailed.bouncedRecipient, 'reservas@hotelsol.example.mx');
    assert.strictEqual(xfailed.bounceDetail, 'Delivery has failed to these recipients.');

    // Delay notice: it is a DSN but not a permanent bounce
    const delayed = normalizeGmailMessage({
        id: 'm-delay', internalDate: t(4),
        payload: {
            mimeType: 'multipart/report',
            headers: [{ name: 'From', value: 'mailer-daemon@googlemail.com' }],
            parts: [{ mimeType: 'message/delivery-status', body: { data: b64('Final-Recipient: rfc822; reservas@hotelsol.example.mx\nAction: delayed\nStatus: 4.4.1') } }]
        }
    }, { ourEmails: OUR });
    assert.strictEqual(delayed.isBounce, true);
    assert.strictEqual(isHardBounce(delayed), false);
    // Real Gmail delay notice: no Action or Status, only the subject gives it away.
    assert.strictEqual(isHardBounce({ isBounce: true, bounceAction: null, bounceStatus: null, subject: 'Delivery Status Notification (Delay)', textBody: '' }), false);
    assert.strictEqual(isHardBounce({ isBounce: true, bounceAction: null, bounceStatus: null, subject: 'Delivery Status Notification (Failure)', textBody: 'Address not found' }), true);

    // ---------------------------------------------------------------------
    // Generic domains and Gmail queries
    // ---------------------------------------------------------------------
    ['gmail.com', 'hotmail.es', 'outlook.com', 'yahoo.co.uk', 'icloud.com', 'live.com.mx', '@gmx.de', ''].forEach(domain => {
        assert.strictEqual(rules.isGenericEmailDomain(domain), true, domain);
    });
    ['hotelsol.example.mx', 'marriott.com', 'livehotels.com'].forEach(domain => {
        assert.strictEqual(rules.isGenericEmailDomain(domain), false, domain);
    });

    const after = Math.floor((sentAt.getTime() - 5 * 60000) / 1000);
    assert.deepStrictEqual(rules.buildFollowUpSearchQueries({ sentTo: 'Reservas@HotelSol.example.mx', sentAt }), {
        bounceQuery: `from:(mailer-daemon OR postmaster) after:${after}`,
        senderQuery: `from:reservas@hotelsol.example.mx after:${after}`,
        domainQuery: `from:@hotelsol.example.mx after:${after}`
    });
    assert.strictEqual(rules.buildFollowUpSearchQueries({ sentTo: 'hotelsol@gmail.com', sentAt }).domainQuery, null);

    // ---------------------------------------------------------------------
    // Selection of replies and bounces
    // ---------------------------------------------------------------------
    const otherBooking = normalizeGmailMessage({
        id: 'm-other', internalDate: t(90),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sales@hotelsol.example.mx' }], body: { data: b64('Confirmamos la reserva de García.') } }
    }, { ourEmails: OUR });
    const relatedDomain = normalizeGmailMessage({
        id: 'm-related', internalDate: t(30),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'frontdesk@hotelsol.example.mx' }], body: { data: b64('Reserva de la Sra. Perez confirmada.') } }
    }, { ourEmails: OUR });
    const oldMessage = Object.assign({}, hotelReply, { id: 'm-old', internalDate: sentAt.getTime() - 24 * 3600000 });

    const terms = rules.buildHotelMatchTerms({ service: serviceEs, reservation: reservationEs });
    assert.ok(terms.includes('perez') && terms.includes('lopez'));

    const followUps = rules.selectHotelFollowUps({
        sentAt,
        sentTo: 'reservas@hotelsol.example.mx',
        rfcMessageId: '<CAabc123@mail.gmail.com>',
        sentMessageId: 'm-sent',
        threadMessages: [ourSent, hotelReply],
        bounceCandidates: [delayed],
        senderMessages: [hotelReply, oldMessage],
        domainMessages: [otherBooking, relatedDomain, hotelReply],
        matchTerms: terms
    });
    assert.strictEqual(followUps.bounce, null);
    assert.deepStrictEqual(followUps.replies.map(m => m.id), ['m-related', 'm-reply']);

    const bounced = rules.selectHotelFollowUps({
        sentAt,
        sentTo: 'reservas@hotelsol.example.mx',
        rfcMessageId: '<CAabc123@mail.gmail.com>',
        threadMessages: [ourSent],
        bounceCandidates: [xfailed, dsn]
    });
    assert.deepStrictEqual(bounced.bounce, { recipient: 'reservas@hotelsol.example.mx', detail: '550 5.1.1 User unknown in virtual mailbox table', messageId: 'm-dsn' });
    assert.deepStrictEqual(bounced.replies, []);

    // An unrelated bounce (different recipient, without our Message-ID) is ignored
    const foreignBounce = Object.assign({}, xfailed, { id: 'm-foreign', bouncedRecipient: 'otro@hotel.com', bounceSearchText: 'otro@hotel.com' });
    assert.strictEqual(rules.selectHotelFollowUps({ sentAt, sentTo: 'reservas@hotelsol.example.mx', bounceCandidates: [foreignBounce] }).bounce, null);

    // findHotelFollowUps with mocked Gmail
    const queries = [];
    const fakeGoogle = {
        getThreadMessagesNormalized: async threadId => {
            assert.strictEqual(threadId, 'th-1');
            return [ourSent, hotelReply];
        },
        searchMessagesNormalized: async query => {
            queries.push(query);
            if (query.startsWith('from:(mailer-daemon')) return [];
            if (query.startsWith('from:@')) return [otherBooking, relatedDomain];
            return [hotelReply];
        }
    };
    const found = await hotel.findHotelFollowUps({
        task: { gmailThreadId: 'th-1' },
        sentAt,
        sentTo: 'reservas@hotelsol.example.mx',
        rfcMessageId: '<CAabc123@mail.gmail.com>',
        service: serviceEs,
        reservation: reservationEs
    }, { google: fakeGoogle });
    assert.strictEqual(queries.length, 3);
    assert.strictEqual(found.bounce, null);
    assert.deepStrictEqual(found.replies.map(m => m.id), ['m-related', 'm-reply']);

    // sendHotelConfirmationEmail with mocked Gmail
    process.env.SUPPLIER_EMAIL_FROM_NAME = 'NomadFlight';
    process.env.SUPPLIER_EMAIL_FROM_ADDRESS = 'bookings@example.com';
    let sendArgs = null;
    const sendGoogle = {
        encodeEmailHeader: text => text,
        sendEmail: async (...args) => {
            sendArgs = args;
            return { success: true, messageId: 'gm-1', threadId: 'th-9' };
        },
        getMessageNormalized: async id => {
            assert.strictEqual(id, 'gm-1');
            return { rfcMessageId: '<CAxyz@mail.gmail.com>' };
        }
    };
    const sent = await hotel.sendHotelConfirmationEmail({ task: { _id: 't1' }, service: serviceEs, reservation: reservationEs }, { google: sendGoogle });
    assert.strictEqual(sendArgs[0], 'NomadFlight <bookings@example.com>');
    assert.strictEqual(sendArgs[1], sendArgs[0]);
    assert.strictEqual(sendArgs[2], 'reservas@hotelsol.example.mx');
    assert.strictEqual(sendArgs[3], es.subject);
    assert.strictEqual(sendArgs[4], es.html);
    assert.deepStrictEqual(sendArgs[5], []);
    assert.strictEqual(sendArgs[6], null);
    assert.strictEqual(sent.threadId, 'th-9');
    assert.strictEqual(sent.messageId, 'gm-1');
    assert.strictEqual(sent.rfcMessageId, '<CAxyz@mail.gmail.com>');
    assert.strictEqual(sent.sentTo, 'reservas@hotelsol.example.mx');
    await assert.rejects(
        hotel.sendHotelConfirmationEmail({ service: Object.assign({}, serviceEs, { hotelRooms: [] }) }, { google: sendGoogle }),
        /hotel_confirmation_email_invalid:hotel_rooms_missing/
    );

    // ---------------------------------------------------------------------
    // Safe automatic confirmation
    // ---------------------------------------------------------------------
    const safe = { category: 'confirmed_all', confidence: 'high', differences: [], missingInfo: [] };
    assert.strictEqual(hotel.isSafeAutoConfirmation(safe), true);
    assert.strictEqual(hotel.isSafeAutoConfirmation(Object.assign({}, safe, { confidence: 'medium' })), false);
    assert.strictEqual(hotel.isSafeAutoConfirmation(Object.assign({}, safe, { differences: ['Régimen AD en vez de TI'] })), false);
    assert.strictEqual(hotel.isSafeAutoConfirmation(Object.assign({}, safe, { missingInfo: ['Hora de llegada'] })), false);
    assert.strictEqual(hotel.isSafeAutoConfirmation(Object.assign({}, safe, { category: 'discrepancy' })), false);
    assert.strictEqual(hotel.isSafeAutoConfirmation(null), false);

    // ---------------------------------------------------------------------
    // Mocked OpenAI
    // ---------------------------------------------------------------------
    const calls = [];
    const fakeClient = output => ({
        responses: {
            parse: async params => {
                calls.push(params);
                return { output_parsed: output };
            }
        }
    });

    const classification = await hotel.classifyHotelReply({
        replies: [hotelReply],
        service: serviceEs,
        reservation: reservationEs
    }, {
        client: fakeClient({
            category: 'confirmed_all',
            confirmationNumber: ' 778899 ',
            confirmedItems: ['Fechas'],
            differences: [],
            missingInfo: [],
            confidence: 'high',
            summary: 'El hotel confirma la reserva.'
        })
    });
    assert.strictEqual(classification.confirmationNumber, '778899');
    assert.strictEqual(hotel.isSafeAutoConfirmation(classification), true);
    const classifyCall = calls[0];
    assert.strictEqual(classifyCall.model, 'gpt-6.1-sol');
    assert.deepStrictEqual(classifyCall.reasoning, { effort: 'medium' });
    assert.strictEqual(classifyCall.temperature, undefined);
    assert.strictEqual(classifyCall.text.format.type, 'json_schema');
    assert.strictEqual(classifyCall.text.format.strict, true);
    assert.ok(classifyCall.input.includes('Ana Pérez López'));
    assert.ok(classifyCall.input.includes('778899'));

    // Unexpected output → downgraded to unsafe
    const weird = await hotel.classifyHotelReply({ replies: [hotelReply], service: serviceEs }, {
        client: fakeClient({ category: 'yes', confidence: 'very', differences: null })
    });
    assert.strictEqual(weird.category, 'other');
    assert.strictEqual(weird.confidence, 'low');
    assert.strictEqual(hotel.isSafeAutoConfirmation(weird), false);
    await assert.rejects(hotel.classifyHotelReply({ replies: [] }, { client: fakeClient({}) }), /no_replies/);

    // Draft reply to the hotel: instructions, language, context and correction
    const draftCallsStart = calls.length;
    const draftBody = await hotel.draftHotelReplyEmail({
        instructions: 'pregunta por el early check-in a las 7',
        service: serviceEs,
        lang: 'en',
        hotelReplyText: 'We confirm your booking.',
        previousDraft: 'Dear team, ...',
        corrections: 'más corto'
    }, { client: fakeClient({ body: '  Dear team,\n\nCould you confirm early check-in?\n\nBest regards,  ' }) });
    assert.strictEqual(draftBody, 'Dear team,\n\nCould you confirm early check-in?\n\nBest regards,');
    const draftInput = JSON.parse(calls[draftCallsStart].input);
    assert.strictEqual(draftInput.idioma, 'en');
    assert.strictEqual(draftInput.indicacionesDelOperador, 'pregunta por el early check-in a las 7');
    assert.strictEqual(draftInput.ultimaRespuestaDelHotel, 'We confirm your booking.');
    assert.strictEqual(draftInput.cambiosPedidos, 'más corto');
    assert.strictEqual(calls[draftCallsStart].text.format.name, 'hotel_reply_draft');
    assert.match(calls[draftCallsStart].instructions, /No inventes ni prometas nada/);
    await assert.rejects(hotel.draftHotelReplyEmail({ instructions: ' ', service: serviceEs, lang: 'es' }, { client: fakeClient({ body: 'x' }) }), /missing_instructions/);
    await assert.rejects(hotel.draftHotelReplyEmail({ instructions: 'hola', service: serviceEs, lang: 'es' }, { client: fakeClient({ body: ' ' }) }), /draft_empty/);

    // Alternative email
    const alt = await hotel.findAlternativeHotelEmail({ service: serviceEs, excludeEmails: ['old@hotelsol.example.mx'] }, {
        client: fakeClient({ email: 'Booking@HotelSol.example.mx', sourceUrl: 'https://hotelsol.example.mx/contacto', confidence: 'high' })
    });
    assert.deepStrictEqual(alt, { email: 'booking@hotelsol.example.mx', sourceUrl: 'https://hotelsol.example.mx/contacto', confidence: 'high' });
    const altCall = calls[calls.length - 1];
    assert.deepStrictEqual(altCall.tools, [{ type: 'web_search' }]);
    assert.strictEqual(altCall.text.format.strict, true);
    assert.ok(altCall.input.includes('old@hotelsol.example.mx'));

    const altCases = [
        { email: 'old@hotelsol.example.mx', sourceUrl: null, confidence: 'high' }, // excluded
        { email: 'reservas@hotelsol.example.mx', sourceUrl: null, confidence: 'high' }, // the service's current one
        { email: 'otro@hotelsol.example.mx', sourceUrl: null, confidence: 'low' },
        { email: 'no-es-email', sourceUrl: null, confidence: 'high' },
        { email: 'hotel@guest.booking.com', sourceUrl: null, confidence: 'high' },
        { email: null, sourceUrl: null, confidence: 'low' }
    ];
    for (const output of altCases) {
        const result = await hotel.findAlternativeHotelEmail({ service: serviceEs, excludeEmails: ['old@hotelsol.example.mx'] }, { client: fakeClient(output) });
        assert.strictEqual(result, null, JSON.stringify(output));
    }

    console.log('OK test-reservation-auto-task-hotel');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
