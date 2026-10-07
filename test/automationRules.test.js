const assert = require('assert');
const {
    TRAVELINSURE_ASSISTANCE_PHONE,
    buildReservationEmailRecipients,
    decideAssuranceEmail,
    decideOneMonthBefore,
    decidePaymentClient,
    decideTenDaysBefore,
    getInitialAutomationStatus,
    isAutomationEnabledForTaskType,
    isTaskDue,
    isWithinAutomationWindow,
    selectPrimaryAssuranceService,
    decideConfirmation,
    getHotelReplyDeadline,
    isConfirmationUrgent,
    isTaskDueForAutomation
} = require('../src/automationRules');

// October 1, 2026 at 9:00 in Madrid (UTC+2).
const now = new Date('2026-10-01T07:00:00.000Z');

const reservation = {
    departureDate: '2026/11/01',
    emailNotifications: 'cliente@example.com',
    clients: [
        { name: 'Ana', surname: 'Pérez', email: 'ana@example.com' },
        { name: 'Luis', surname: 'García', email: 'CLIENTE@example.com' }
    ]
};
const assurance = {
    type: 'assurance',
    providerBoughtName: 'Travelinsure',
    providerFinalReference: 'POL-1',
    providerBoughtReference: 'LOC-1'
};
const flight = { type: 'flight', reserved: true, title: 'Vuelo' };

// Time window and task date.
assert.strictEqual(isWithinAutomationWindow(new Date('2026-10-01T06:59:00.000Z')), false);
assert.strictEqual(isWithinAutomationWindow(now), true);
assert.strictEqual(isWithinAutomationWindow(new Date('2026-10-01T19:00:00.000Z')), false);
assert.strictEqual(isTaskDue({ date: '01/10/2026' }, now), true);
assert.strictEqual(isTaskDue({ date: '30/09/2026' }, now), true);
assert.strictEqual(isTaskDue({ date: '02/10/2026' }, now), false);

// Initial state: new ones are scheduled; existing ones only if their date has not arrived yet.
assert.strictEqual(getInitialAutomationStatus({ taskType: 'OneMonthBefore', isDone: false, isNewTask: true, taskDate: '01/09/2026', now }), 'scheduled');
assert.strictEqual(getInitialAutomationStatus({ taskType: 'OneMonthBefore', isDone: false, isNewTask: false, taskDate: '02/10/2026', now }), 'scheduled');
assert.strictEqual(getInitialAutomationStatus({ taskType: 'OneMonthBefore', isDone: false, isNewTask: false, taskDate: '01/10/2026', now }), null);
assert.strictEqual(getInitialAutomationStatus({ taskType: 'OneMonthBefore', isDone: true, isNewTask: true, taskDate: '02/10/2026', now }), null);
assert.strictEqual(getInitialAutomationStatus({ taskType: 'Checkin', isDone: false, isNewTask: true, taskDate: '02/10/2026', now }), null);

// Per-type switch.
assert.strictEqual(isAutomationEnabledForTaskType('OneMonthBefore', ''), true);
assert.strictEqual(isAutomationEnabledForTaskType('OneMonthBefore', 'PaymentClient, OneMonthBefore'), false);
assert.strictEqual(isAutomationEnabledForTaskType('Checkin', ''), false);

// Recipients: notifications + the owner + clients without duplicates; retailer without clients.
assert.deepStrictEqual(
    buildReservationEmailRecipients(reservation),
    ['cliente@example.com', 'ops@example.com', 'ana@example.com']
);
assert.deepStrictEqual(
    buildReservationEmailRecipients({ ...reservation, retailTravelAgencyId: 'agency' }),
    ['cliente@example.com', 'ops@example.com']
);
assert.strictEqual(buildReservationEmailRecipients({ ...reservation, emailNotifications: '' }), null);

// Main insurance.
assert.strictEqual(selectPrimaryAssuranceService([{ type: 'assurance' }, assurance]), assurance);
assert.strictEqual(selectPrimaryAssuranceService([flight]), null);

// 1 month before departure.
const oneMonthTask = { taskType: 'OneMonthBefore', date: '01/10/2026' };
let decision = decideOneMonthBefore({ task: oneMonthTask, reservation, services: [assurance, flight], now });
assert.strictEqual(decision.action, 'send');
assert.strictEqual(decision.fields.assurancephone, TRAVELINSURE_ASSISTANCE_PHONE);
assert.strictEqual(decision.fields.withoutflights, false);
assert.strictEqual(decision.fields.name, 'Ana Pérez, Luis García');
assert.strictEqual(decision.fields.traveleralone, false);

decision = decideOneMonthBefore({ task: oneMonthTask, reservation, services: [], now });
assert.strictEqual(decision.action, 'send');
assert.strictEqual(decision.fields.assurancephone, undefined);
assert.strictEqual(decision.fields.withoutflights, true);

assert.strictEqual(decideOneMonthBefore({ task: { ...oneMonthTask, date: '15/09/2026' }, reservation, services: [], now }).action, 'discarded');
assert.strictEqual(decideOneMonthBefore({ task: oneMonthTask, reservation: { ...reservation, emailMonthBeforeTravel: true }, services: [], now }).action, 'executed');
assert.strictEqual(decideOneMonthBefore({ task: oneMonthTask, reservation: { ...reservation, canceled: true }, services: [], now }).action, 'discarded');
assert.strictEqual(decideOneMonthBefore({ task: oneMonthTask, reservation: { ...reservation, emailNotifications: null }, services: [], now }).action, 'manual');
assert.strictEqual(decideOneMonthBefore({ task: oneMonthTask, reservation, services: [{ ...assurance, providerBoughtName: 'Mapfre' }], now }).action, 'manual');

// Insurance email.
decision = decideAssuranceEmail({ reservation, services: [assurance], now });
assert.strictEqual(decision.action, 'send');
assert.strictEqual(decision.fields.polizaSeguro, 'POL-1');
assert.strictEqual(decision.fields.localizadorSeguro, 'LOC-1');
assert.strictEqual(decideAssuranceEmail({ reservation, services: [flight], now }).action, 'discarded');
assert.strictEqual(decideAssuranceEmail({ reservation, services: [{ ...assurance, providerBoughtName: '' }], now }).action, 'manual');
assert.strictEqual(decideAssuranceEmail({ reservation, services: [{ ...assurance, providerBoughtReference: '' }], now }).action, 'manual');
assert.strictEqual(decideAssuranceEmail({ reservation: { ...reservation, departureDate: '2026/10/01' }, services: [assurance], now }).action, 'discarded');
assert.strictEqual(decideAssuranceEmail({ reservation: { ...reservation, departureDate: '2026/10/02' }, services: [assurance], now }).action, 'send');

// Final client payment and 10 days before departure.
assert.strictEqual(decidePaymentClient({ reservation, payments: [{ totalPending: 0 }], now }).action, 'executed');
assert.strictEqual(decidePaymentClient({ reservation, payments: [{ totalPending: 150 }], now }).action, 'manual');
assert.strictEqual(decideTenDaysBefore({ reservation, payments: [], services: [flight, { type: 'baggage', reserved: false }], now }).action, 'executed');
decision = decideTenDaysBefore({ reservation, payments: [], services: [{ type: 'hotel', reserved: false, title: 'Hotel Sol' }], now });
assert.strictEqual(decision.action, 'manual');
assert.match(decision.reason, /Hotel Sol/);

const templateCheck = Promise.resolve();

// Activity and transfer confirmations: 24 h before, at any time of day.
const transfer = { type: 'transfer', dateStart: '02/10/2026', dateStartHour: '08:30', dateStartTimeZone: 'Europe/Madrid', providerFinalPhone: '+34600000000' };
const confirmationTask = { taskType: 'Confirmation', date: '01/10/2026 08:30' };
assert.strictEqual(isTaskDueForAutomation(confirmationTask, transfer, new Date('2026-10-01T06:00:00.000Z')), false);
assert.strictEqual(isTaskDueForAutomation(confirmationTask, transfer, new Date('2026-10-01T06:30:00.000Z')), true);
assert.strictEqual(isTaskDueForAutomation(confirmationTask, transfer, new Date('2026-09-30T23:00:00.000Z')), false);
assert.strictEqual(isConfirmationUrgent(transfer, new Date('2026-10-01T23:00:00.000Z')), true);
assert.strictEqual(isConfirmationUrgent(transfer, new Date('2026-10-01T18:00:00.000Z')), false);
assert.deepStrictEqual(decideConfirmation({ task: confirmationTask, reservation, service: transfer, now }), { action: 'sendWhatsapp', urgent: false });
assert.strictEqual(decideConfirmation({ task: confirmationTask, reservation, service: transfer, now: new Date('2026-10-01T22:00:00.000Z') }).urgent, true);
assert.strictEqual(decideConfirmation({ task: confirmationTask, reservation, service: { ...transfer, confirmed: true }, now }).action, 'executed');
assert.strictEqual(decideConfirmation({ task: confirmationTask, reservation, service: transfer, now: new Date('2026-10-02T07:00:00.000Z') }).action, 'discarded');

// Hotels: on the task day from 9:00 onwards; with no email an alternative one is looked up.
const hotel = { type: 'hotel', dateStart: '11/10/2026', providerFinalEmail: 'reservas@hotel.com', providerFinalPhone: '+34950000000' };
const hotelTask = { taskType: 'Confirmation', date: '01/10/2026' };
assert.strictEqual(isTaskDueForAutomation(hotelTask, hotel, new Date('2026-10-01T06:00:00.000Z')), false);
assert.strictEqual(isTaskDueForAutomation(hotelTask, hotel, now), true);
assert.deepStrictEqual(decideConfirmation({ task: hotelTask, reservation, service: hotel, now }), { action: 'sendHotelEmail', toEmail: 'reservas@hotel.com' });
assert.deepStrictEqual(decideConfirmation({ task: hotelTask, reservation, service: { ...hotel, providerFinalEmail: '' }, now }), { action: 'sendHotelEmail', toEmail: null });
assert.strictEqual(decideConfirmation({ task: { ...hotelTask, gmailThreadId: 'abc' }, reservation, service: hotel, now }).action, 'manual');

// Hotel reply deadline: 4 days, at the latest 2 days before check-in, minimum 6 h.
assert.strictEqual(getHotelReplyDeadline(hotel, now).toISOString(), '2026-10-05T07:00:00.000Z');
assert.strictEqual(getHotelReplyDeadline({ ...hotel, dateStart: '05/10/2026' }, now).toISOString(), '2026-10-03T07:00:00.000Z');
assert.strictEqual(getHotelReplyDeadline({ ...hotel, dateStart: '02/10/2026' }, now).toISOString(), '2026-10-01T13:00:00.000Z');

templateCheck.then(() => {
    console.log('Reglas de automatización de auto tareas: OK');
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
