const moment = require('moment-timezone');

// Pure rules for auto task automation: they decide whether a task runs
// on its own, is left manual or is discarded. No database access.

const AUTOMATION_TIMEZONE = 'Europe/Madrid';
const AUTOMATION_START_HOUR = 9;
const AUTOMATION_END_HOUR = 21;

const AUTOMATED_TASK_TYPES = [
    'OneMonthBefore',
    'TenDaysBeforeAssurance',
    'PaymentClient',
    'TenDaysBefore',
    // Only exists for hotels, activities and transfers.
    'Confirmation'
];

// Travelinsure 24h assistance phone, the same one the back-office panel suggests.
const TRAVELINSURE_ASSISTANCE_PHONE = '+34 900 000 000';
const AGENT_COPY_EMAIL = process.env.AGENT_COPY_EMAIL || 'ops@example.com';
const MAX_EMAIL_RECIPIENTS = 11;

const AUTOMATION_STATUS = {
    SCHEDULED: 'scheduled',
    PROCESSING: 'processing',
    WAITING: 'waiting',
    EXECUTED: 'executed',
    MANUAL: 'manual',
    DISCARDED: 'discarded'
};

function isAutomatedTaskType(taskType) {
    return AUTOMATED_TASK_TYPES.includes(taskType);
}

function getDisabledAutomationTaskTypes(rawValue = process.env.AGENT_DISABLED_TASK_TYPES) {
    return String(rawValue || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
}

function isAutomationEnabledForTaskType(taskType, rawDisabledValue) {
    return isAutomatedTaskType(taskType)
        && !getDisabledAutomationTaskTypes(rawDisabledValue).includes(taskType);
}

function getMadridNow(now = new Date()) {
    return moment(now).tz(AUTOMATION_TIMEZONE);
}

function isWithinAutomationWindow(now = new Date()) {
    const hour = getMadridNow(now).hour();
    return hour >= AUTOMATION_START_HOUR && hour < AUTOMATION_END_HOUR;
}

// Activity and transfer confirmations include a time ('DD/MM/YYYY HH:mm').
function parseTaskDate(date) {
    return moment.tz(String(date || '').slice(0, 10), 'DD/MM/YYYY', true, AUTOMATION_TIMEZONE);
}

function isTaskDue(task, now = new Date()) {
    const taskDate = parseTaskDate(task?.date);
    if (!taskDate.isValid()) return false;
    return taskDate.isSameOrBefore(getMadridNow(now), 'day');
}

// Initial status of an automatable task. New tasks start out scheduled.
// Existing ones without a status are only scheduled if their date has not yet arrived:
// those due today or overdue at deployment stay manual, as before.
function getInitialAutomationStatus({ taskType, isDone, isNewTask, taskDate, hasGmailThread = false, now = new Date() }) {
    if (!isAutomatedTaskType(taskType) || isDone === true) return null;
    // If the hotel was already emailed from the back-office panel, the task stays manual.
    if (hasGmailThread) return null;
    if (isNewTask) return AUTOMATION_STATUS.SCHEDULED;

    const parsedDate = parseTaskDate(taskDate);
    if (!parsedDate.isValid()) return null;
    return parsedDate.isAfter(getMadridNow(now), 'day')
        ? AUTOMATION_STATUS.SCHEDULED
        : null;
}

function getClientFullName(client) {
    if (!client) return '';
    return [client.name, client.surname]
        .filter(value => value && String(value).trim() !== '')
        .map(value => String(value).trim())
        .join(' ');
}

// Same criteria as the back-office panel (useEmailDialogBase.getReservationTravelersName).
function getReservationTravelersName(reservation, client = null) {
    if (reservation?.clientsNames && String(reservation.clientsNames).trim() !== '') {
        return String(reservation.clientsNames).trim();
    }

    const clientNames = Array.isArray(reservation?.clients)
        ? reservation.clients.map(getClientFullName).filter(Boolean)
        : [];
    if (clientNames.length > 0) return clientNames.join(', ');

    return getClientFullName(client);
}

function isTravelerAlone(reservation) {
    return Array.isArray(reservation?.clients) && reservation.clients.length === 1;
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// Main recipient: notifications email. Copies: the owner and, unless it is a
// retailer booking, the customers' emails (same criteria as the back-office panel).
function buildReservationEmailRecipients(reservation, client = null) {
    const mainEmail = String(reservation?.emailNotifications || '').trim();
    if (!isValidEmail(mainEmail)) return null;

    const recipients = [mainEmail];
    const seen = new Set([mainEmail.toLowerCase()]);
    const add = email => {
        const value = String(email || '').trim();
        if (!isValidEmail(value) || seen.has(value.toLowerCase())) return;
        if (recipients.length >= MAX_EMAIL_RECIPIENTS) return;
        seen.add(value.toLowerCase());
        recipients.push(value);
    };

    add(AGENT_COPY_EMAIL);
    if (!reservation?.retailTravelAgencyId) {
        add(client?.email);
        for (const reservationClient of reservation?.clients || []) {
            add(reservationClient?.email);
        }
    }
    return recipients;
}

// Same criteria as the back-office panel: first insurance with data, otherwise the first one.
function selectPrimaryAssuranceService(services = []) {
    const assurances = (services || []).filter(service => service?.type === 'assurance');
    return assurances.find(service =>
        service.providerFinalReference
        || service.providerBoughtReference
        || (Array.isArray(service.assuranceClients) && service.assuranceClients.length > 0)
    ) || assurances[0] || null;
}

function isTravelinsureAssurance(service) {
    const providerNames = [service?.providerBoughtName, service?.providerFinalName]
        .filter(Boolean)
        .join(' ');
    return /travelinsure/i.test(providerNames);
}

function hasFlightService(services = []) {
    return (services || []).some(service => service?.type === 'flight');
}

function parseDepartureDate(reservation) {
    return moment.tz(reservation?.departureDate, 'YYYY/MM/DD', true, AUTOMATION_TIMEZONE);
}

function manual(reason) {
    return { action: AUTOMATION_STATUS.MANUAL, reason };
}

function discard(reason) {
    return { action: AUTOMATION_STATUS.DISCARDED, reason };
}

function done(reason) {
    return { action: AUTOMATION_STATUS.EXECUTED, reason };
}

function getCommonReservationBlock(reservation, now) {
    if (!reservation) return discard('La reserva ya no existe');
    if (reservation.canceled === true) return discard('Reserva cancelada');

    const departureDate = parseDepartureDate(reservation);
    if (!departureDate.isValid()) return manual('La reserva no tiene una fecha de salida válida');
    if (departureDate.isSameOrBefore(getMadridNow(now), 'day')) {
        return discard('La fecha de salida ya ha llegado');
    }
    return null;
}

function decideOneMonthBefore({ task, reservation, client, services, now = new Date() }) {
    const block = getCommonReservationBlock(reservation, now);
    if (block) return block;
    if (reservation.emailMonthBeforeTravel === true) return done('El email ya se había enviado');

    // Only sent on the due day: if the booking comes in less than 1 month ahead, it is discarded.
    const taskDate = parseTaskDate(task?.date);
    if (!taskDate.isValid() || !taskDate.isSame(getMadridNow(now), 'day')) {
        return discard('La reserva se creó o cambió con menos de 1 mes de antelación');
    }

    const recipients = buildReservationEmailRecipients(reservation, client);
    if (!recipients) return manual('La reserva no tiene email de notificaciones válido');

    const assurance = selectPrimaryAssuranceService(services);
    if (assurance && !isTravelinsureAssurance(assurance)) {
        return manual('El seguro no indica Travelinsure como proveedor: revisar el teléfono de asistencia');
    }

    const fields = {
        name: getReservationTravelersName(reservation, client),
        traveleralone: isTravelerAlone(reservation),
        withoutflights: !hasFlightService(services)
    };
    if (assurance) fields.assurancephone = TRAVELINSURE_ASSISTANCE_PHONE;

    return {
        action: 'send',
        email: 'oneMonthBefore',
        recipients,
        fields,
        reservationFlag: 'emailMonthBeforeTravel',
        reason: assurance
            ? 'Email de 1 mes enviado'
            : 'Email de 1 mes enviado sin teléfono de seguro (no hay seguro contratado)'
    };
}

function decideAssuranceEmail({ reservation, client, services, now = new Date() }) {
    const block = getCommonReservationBlock(reservation, now);
    if (block) return block;
    if (reservation.emailTenDaysBeforeTravelAssurance === true) return done('El email ya se había enviado');

    const assurance = selectPrimaryAssuranceService(services);
    if (!assurance) return discard('Sin seguro contratado por NomadFlight');
    if (!isTravelinsureAssurance(assurance)) {
        return manual('El seguro no indica Travelinsure como proveedor');
    }
    if (!assurance.providerFinalReference || !assurance.providerBoughtReference) {
        return manual('Falta el número de póliza o el localizador del seguro');
    }

    const recipients = buildReservationEmailRecipients(reservation, client);
    if (!recipients) return manual('La reserva no tiene email de notificaciones válido');

    const assuranceClientNames = (assurance.assuranceClients || [])
        .map(assuranceClient => assuranceClient?.fullClientName)
        .filter(Boolean)
        .join(', ');

    return {
        action: 'send',
        email: 'assurance',
        recipients,
        fields: {
            name: getReservationTravelersName(reservation, client) || assuranceClientNames,
            traveleralone: isTravelerAlone(reservation),
            polizaSeguro: assurance.providerFinalReference,
            localizadorSeguro: assurance.providerBoughtReference
        },
        reservationFlag: 'emailTenDaysBeforeTravelAssurance',
        reason: 'Email de la app del seguro enviado'
    };
}

function hasPendingAmount(payment) {
    const pending = parseFloat(payment?.totalPending);
    return Number.isFinite(pending) && pending > 0;
}

function decidePaymentClient({ reservation, payments, now = new Date() }) {
    if (!reservation) return discard('La reserva ya no existe');
    if (reservation.canceled === true) return discard('Reserva cancelada');

    const pendingPayments = (payments || []).filter(hasPendingAmount);
    if (pendingPayments.length === 0) return done('Sin pagos pendientes del cliente');
    return manual(`Pagos pendientes del cliente: ${pendingPayments.length}`);
}

// Same criteria as the back-office panel: payments with an outstanding amount and unbooked
// services (not counting baggage).
function decideTenDaysBefore({ reservation, payments, services, now = new Date() }) {
    if (!reservation) return discard('La reserva ya no existe');
    if (reservation.canceled === true) return discard('Reserva cancelada');

    const pendingPayments = (payments || []).filter(hasPendingAmount);
    const unreservedServices = (services || []).filter(service =>
        !service?.reserved && service?.type !== 'baggage'
    );
    if (pendingPayments.length === 0 && unreservedServices.length === 0) {
        return done('Sin pagos pendientes ni servicios sin reservar');
    }

    const reasons = [];
    if (pendingPayments.length > 0) reasons.push(`pagos pendientes: ${pendingPayments.length}`);
    if (unreservedServices.length > 0) {
        reasons.push(`servicios sin reservar: ${unreservedServices.map(service => service.title).join(', ')}`);
    }
    return manual(`Revisar ${reasons.join('; ')}`);
}

const HOTEL_REPLY_DAYS = 4;
const HOTEL_DEADLINE_DAYS_BEFORE_CHECKIN = 2;
const HOTEL_MIN_REPLY_HOURS = 6;
const SERVICE_CONFIRMATION_HOURS_BEFORE = 24;
const SERVICE_CONFIRMATION_URGENT_HOURS = 10;

function isWhatsappConfirmationService(service) {
    return ['activity', 'transfer'].includes(service?.type);
}

function getServiceStart(service) {
    if (!service?.dateStart) return null;
    const timezone = service.dateStartTimeZone || AUTOMATION_TIMEZONE;
    const value = service.dateStartHour
        ? `${service.dateStart} ${service.dateStartHour}`
        : `${service.dateStart} 00:00`;
    const start = moment.tz(value, 'DD/MM/YYYY HH:mm', true, timezone);
    return start.isValid() ? start : null;
}

function getHoursUntilServiceStart(service, now = new Date()) {
    const start = getServiceStart(service);
    return start ? start.diff(moment(now), 'minutes') / 60 : null;
}

// When a task is decided: activity and transfer confirmations, 24 h before
// the service at any time of day; the rest, on the task's day between 9:00 and 21:00.
function isTaskDueForAutomation(task, service, now = new Date()) {
    if (task?.taskType === 'Confirmation' && isWhatsappConfirmationService(service)) {
        const hours = getHoursUntilServiceStart(service, now);
        return hours !== null && hours <= SERVICE_CONFIRMATION_HOURS_BEFORE;
    }
    return isWithinAutomationWindow(now) && isTaskDue(task, now);
}

function isConfirmationUrgent(service, now = new Date()) {
    const hours = getHoursUntilServiceStart(service, now);
    return hours !== null && hours < SERVICE_CONFIRMATION_URGENT_HOURS;
}

// Deadline for treating the email to the hotel as unanswered: 4 full days, but never
// later than 2 days before check-in (at 9:00) nor earlier than 6 h after sending.
function getHotelReplyDeadline(service, sentAt = new Date()) {
    const sent = moment(sentAt);
    let deadline = sent.clone().add(HOTEL_REPLY_DAYS, 'days');
    const checkIn = moment.tz(service?.dateStart, 'DD/MM/YYYY', true, AUTOMATION_TIMEZONE);
    if (checkIn.isValid()) {
        const latest = checkIn.clone()
            .subtract(HOTEL_DEADLINE_DAYS_BEFORE_CHECKIN, 'days')
            .hour(AUTOMATION_START_HOUR);
        if (latest.isBefore(deadline)) deadline = latest;
    }
    const earliest = sent.clone().add(HOTEL_MIN_REPLY_HOURS, 'hours');
    if (deadline.isBefore(earliest)) deadline = earliest;
    return deadline.toDate();
}

function getProviderPhoneText(service) {
    const phone = service?.providerFinalPhone || service?.providerBoughtPhone;
    return phone ? ` (tel. ${phone})` : '';
}

function decideConfirmation({ task, reservation, service, now = new Date() }) {
    if (!reservation) return discard('La reserva ya no existe');
    if (reservation.canceled === true) return discard('Reserva cancelada');
    if (!service) return discard('El servicio ya no existe');
    if (service.confirmed === true) return done('El servicio ya estaba confirmado');

    if (isWhatsappConfirmationService(service)) {
        const hours = getHoursUntilServiceStart(service, now);
        if (hours === null) return { ...manual('El servicio no tiene fecha y hora válidas'), urgent: true };
        if (hours < 0) return discard('El servicio ya ha empezado');
        return { action: 'sendWhatsapp', urgent: hours < SERVICE_CONFIRMATION_URGENT_HOURS };
    }

    if (service.type === 'hotel') {
        if (task?.gmailThreadId) return manual('Ya hay emails con el hotel enviados desde el panel: revisar');
        const checkIn = moment.tz(service.dateStart, 'DD/MM/YYYY', true, AUTOMATION_TIMEZONE);
        if (checkIn.isValid() && checkIn.isBefore(getMadridNow(now), 'day')) {
            return discard('La fecha del hotel ya ha pasado');
        }
        const email = String(service.providerFinalEmail || '').trim();
        return isValidEmail(email)
            ? { action: 'sendHotelEmail', toEmail: email }
            : { action: 'sendHotelEmail', toEmail: null };
    }

    return manual('Tipo de servicio sin confirmación automática');
}

const AUTOMATION_DECIDERS = {
    OneMonthBefore: decideOneMonthBefore,
    TenDaysBeforeAssurance: decideAssuranceEmail,
    PaymentClient: decidePaymentClient,
    TenDaysBefore: decideTenDaysBefore,
    Confirmation: decideConfirmation
};

function decideAutoTaskAutomation(context) {
    const decider = AUTOMATION_DECIDERS[context?.task?.taskType];
    if (!decider) return manual('Tipo de tarea sin automatización');
    return decider(context);
}

module.exports = {
    AUTOMATED_TASK_TYPES,
    decideConfirmation,
    getHotelReplyDeadline,
    getHoursUntilServiceStart,
    getProviderPhoneText,
    isConfirmationUrgent,
    isTaskDueForAutomation,
    isWhatsappConfirmationService,
    AUTOMATION_STATUS,
    AUTOMATION_TIMEZONE,
    TRAVELINSURE_ASSISTANCE_PHONE,
    buildReservationEmailRecipients,
    decideAssuranceEmail,
    decideAutoTaskAutomation,
    decideOneMonthBefore,
    decidePaymentClient,
    decideTenDaysBefore,
    getDisabledAutomationTaskTypes,
    getInitialAutomationStatus,
    getReservationTravelersName,
    isAutomatedTaskType,
    isAutomationEnabledForTaskType,
    isTravelinsureAssurance,
    isTaskDue,
    isWithinAutomationWindow,
    selectPrimaryAssuranceService
};
