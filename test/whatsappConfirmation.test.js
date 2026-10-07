const assert = require('assert');
const {
    buildConfirmationWhatsappTemplate,
    buildFailureReason,
    formatDateNatural,
    formatProviderReplyContextBlock,
    isSpanishSpeakingCountry,
    renderTemplateText,
    sanitizeTelegramText
} = require('../src/whatsappConfirmation');

// Language by the supplier's phone prefix.
assert.strictEqual(isSpanishSpeakingCountry('+34600000000'), true);
assert.strictEqual(isSpanishSpeakingCountry('+18095551234'), true);
assert.strictEqual(isSpanishSpeakingCountry('+255700000000'), false);
assert.strictEqual(formatDateNatural('13/04/2026', true), '13 de Abril');
assert.strictEqual(formatDateNatural('01/04/2026', false), 'April 1st');
assert.strictEqual(formatDateNatural('12/04/2026', false), 'April 12th');
assert.strictEqual(formatDateNatural('22/04/2026', false), 'April 22nd');

const transfer = {
    _id: '64b000000000000000000001',
    type: 'transfer',
    isTransferGo: true,
    providerFinalPhone: '+34600000000',
    dateStart: '13/04/2026',
    dateStartHour: '10:30',
    transferPickupDropffAirport: 'Zanzibar (ZNZ)',
    transferActivityHotelName: 'Hotel Sol',
    transferFlightCode: 'TK123',
    activityTransferClientFullName: 'Ana Pérez'
};

// Outbound transfer in Spanish.
const goEs = buildConfirmationWhatsappTemplate(transfer, {});
assert.strictEqual(goEs.templateName, 'confirmar_traslado_ida_es');
assert.strictEqual(goEs.lang, 'es');
assert.strictEqual(goEs.phoneTo, '+34600000000');
assert.deepStrictEqual(goEs.parameters, ['13 de Abril', '10:30', 'Zanzibar (ZNZ)', 'Hotel Sol', 'TK123', 'Ana Pérez']);
assert.match(goEs.textToDB, /^\*\*\(Template confirmar_traslado_ida_es\)\*\*/);

// Return transfer in English (flight not required, hotel before airport).
const backEn = buildConfirmationWhatsappTemplate({
    ...transfer, isTransferGo: false, providerFinalPhone: '+255700000000', transferFlightCode: ''
}, {});
assert.strictEqual(backEn.templateName, 'confirmar_traslado_vuelta_en');
assert.strictEqual(backEn.lang, 'en');
assert.deepStrictEqual(backEn.parameters, ['April 13th', '10:30', 'Hotel Sol', 'Zanzibar (ZNZ)', 'Ana Pérez']);

// Local phone without "+": the service's time zone decides the language.
const localAr = buildConfirmationWhatsappTemplate({
    ...transfer, providerFinalPhone: '02902 492970', dateStartTimeZone: 'America/Argentina/Rio_Gallegos'
}, {});
assert.strictEqual(localAr.lang, 'es');
assert.strictEqual(localAr.templateName, 'confirmar_traslado_ida_es');
const spanishPhoneAbroad = buildConfirmationWhatsappTemplate({
    ...transfer, dateStartTimeZone: 'Africa/Dar_es_Salaam'
}, {});
assert.strictEqual(spanishPhoneAbroad.lang, 'en');

// Outbound transfer without a flight: a required field is missing.
const goMissing = buildConfirmationWhatsappTemplate({ ...transfer, transferFlightCode: '' }, {});
assert.match(goMissing.error, /Faltan datos.*Número de vuelo/);

const activity = {
    type: 'activity',
    title: 'Safari Blue',
    providerFinalPhone: '+34600000000',
    dateStart: '14/04/2026',
    dateStartHour: '08:00',
    transferActivityHotelName: 'Hotel Sol',
    activityTransferClientFullName: 'Ana Pérez',
    providerBoughtName: 'Agencia Zanzi',
    providerFinalReference: 'REF-1'
};

// Activity with hotel pickup.
const pickup = buildConfirmationWhatsappTemplate(activity, {});
assert.strictEqual(pickup.templateName, 'actividad_con_recogida_hotel_es');
assert.deepStrictEqual(pickup.parameters, ['Hotel Sol', 'Safari Blue', 'Ana Pérez', 'Agencia Zanzi', 'REF-1']);

// Activity without pickup (there is a meeting point), in English.
const meeting = buildConfirmationWhatsappTemplate({
    ...activity, activityMeetingPoint: 'Puerto de Stone Town', providerFinalPhone: '+447700000000'
}, {});
assert.strictEqual(meeting.templateName, 'actividad_sin_recogida_hotel_en');
assert.deepStrictEqual(meeting.parameters, ['Agencia Zanzi', 'REF-1', 'Safari Blue', 'Ana Pérez', '08:00', 'Puerto de Stone Town']);

// No supplier phone or unsupported type.
assert.match(buildConfirmationWhatsappTemplate({ ...activity, providerFinalPhone: '' }, {}).error, /providerFinalPhone/);
assert.match(buildConfirmationWhatsappTemplate({ ...activity, type: 'hotel' }, {}).error, /sin plantilla/);

// textToDB from the Meta template body.
const body = 'Hola, confirmamos el traslado del {{1}} a las {{2}} para {{6}}. Vuelo {{5}}. ¿{{1}}?';
assert.strictEqual(
    renderTemplateText(body, goEs.parameters),
    'Hola, confirmamos el traslado del 13 de Abril a las 10:30 para Ana Pérez. Vuelo TK123. ¿13 de Abril?'
);
assert.strictEqual(renderTemplateText('A {{1}} B {{2}}', ['x', '']), 'A x B {{2}}');
assert.strictEqual(renderTemplateText('A {{1}}', ['$& y $1']), 'A $& y $1');
const withBody = buildConfirmationWhatsappTemplate(transfer, {}, { templateBody: body });
assert.ok(withBody.textToDB.startsWith('Hola, confirmamos el traslado del 13 de Abril'));

// Context block for Telegram.
const sentAt = new Date('2026-04-10T08:05:00.000Z'); // 10:05 in Madrid
const service = { title: 'Traslado aeropuerto - hotel', dateStart: '13/04/2026', dateStartHour: '10:30' };
const reply = formatProviderReplyContextBlock({
    mode: 'reply',
    entries: [{ sentAt, service, reservation: { title: 'Zanzíbar Pérez' }, text: 'Hola. Teléfono: +34999 **Cliente** ' + 'x'.repeat(500) }]
});
assert.ok(reply.startsWith('\n\n↪️ En respuesta a (enviado 10/04 10:05):\nReserva: Zanzíbar Pérez · Traslado aeropuerto - hotel · 13/04/2026 10:30\n"Hola.'));
assert.doesNotMatch(reply, /Teléfono:/);
assert.doesNotMatch(reply, /WhatsApp ID:/);
assert.doesNotMatch(reply, /\*\*Cliente\*\*/);
assert.ok(reply.length < 600);
assert.ok(reply.trimEnd().endsWith('…"'));

// With no booking title the client names are used.
const byNames = formatProviderReplyContextBlock({
    mode: 'reply', entries: [{ sentAt, service, reservation: { clientsNames: 'Ana y Luis' }, text: 'Hola' }]
});
assert.match(byNames, /Reserva: Ana y Luis · /);

const pending = formatProviderReplyContextBlock({
    mode: 'pending',
    entries: Array.from({ length: 7 }, (_, index) => ({ sentAt, service, reservation: { title: `R${index}` }, text: 't' }))
});
assert.match(pending, /^\n\n↪️ Varias confirmaciones pendientes con este proveedor:\n• Reserva: R0 · /);
assert.strictEqual((pending.match(/^• /gm) || []).length, 5);

const last = formatProviderReplyContextBlock({ mode: 'last', entries: [{ sentAt, text: 'Último' }] });
assert.strictEqual(last, '\n\n↪️ Último mensaje enviado (10/04 10:05):\n"Último"');
assert.strictEqual(formatProviderReplyContextBlock({ mode: 'reply', entries: [] }), '');

assert.strictEqual(sanitizeTelegramText('WhatsApp ID: X **Proveedor**'), 'WhatsApp ID X Proveedor');
assert.strictEqual(
    buildFailureReason('131026', 'Message undeliverable'),
    'WhatsApp no entregado al proveedor (131026 - Message undeliverable): contactar por otra vía'
);

console.log('WhatsApp de confirmación de auto tareas: OK');
