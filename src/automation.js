const {
    AutoTaskReservation,
    Client,
    PaymentReservation,
    Reservation,
    ServiceReservation
} = require('./adapters/models');
const emails = require('./adapters/emails');
const notificationAdmin = require('./adapters/notificationAdmin');
const {
    AUTOMATED_TASK_TYPES,
    AUTOMATION_STATUS,
    decideAutoTaskAutomation,
    getHotelReplyDeadline,
    getProviderPhoneText,
    isAutomationEnabledForTaskType,
    isTaskDue,
    isTaskDueForAutomation,
    isWithinAutomationWindow
} = require('./automationRules');

const AUTOMATION_EMAIL_SENDERS = {
    oneMonthBefore: emails.sendEmail1MonthBeforeTravel,
    assurance: emails.sendEmail10DaysBeforeTravelWithAssuranceApp
};

const STUCK_PROCESSING_MINUTES = 30;
const MAX_HOTEL_RESENDS = 1;

// Lazy loading: these modules depend on Gmail and WhatsApp, which need their configuration.
function getHotelModule() {
    return require('./hotelAgent');
}

function getWhatsappModule() {
    return require('./whatsappConfirmation');
}

function getTelegramModule() {
    return require('./telegramReview');
}

function buildLogEntry(action, detail) {
    return { at: new Date(), action, detail };
}

function formatDateTime(date) {
    return require('moment-timezone')(date).tz('Europe/Madrid').format('DD/MM HH:mm');
}

// Claims the task for this process: prevents double sends if two runs overlap.
async function claimTask(taskId, fromStatus) {
    const update = {
        $set: {
            'automation.status': AUTOMATION_STATUS.PROCESSING,
            'automation.claimedAt': new Date()
        }
    };
    // Reply tracking repeats every 30 min: only the initial decision is logged.
    if (fromStatus === AUTOMATION_STATUS.SCHEDULED) {
        update.$push = { 'automation.log': buildLogEntry('claimed', 'Inicio de la decisión automática') };
    }
    return AutoTaskReservation.findOneAndUpdate(
        { _id: taskId, isDone: false, 'automation.status': fromStatus },
        update,
        { returnDocument: 'after' }
    ).lean();
}

async function logTask(taskId, action, detail) {
    await AutoTaskReservation.updateOne(
        { _id: taskId },
        { $push: { 'automation.log': buildLogEntry(action, detail) } }
    );
}

// Closes the task decision with its status, reason and extra tracking fields.
async function updateTaskAutomation(taskId, { status, reason, isDone, isUrgent, fields = {}, rootFields = {} }) {
    const set = {
        isDone,
        'automation.status': status,
        'automation.reason': reason,
        'automation.decidedAt': new Date()
    };
    if (isUrgent !== undefined) set.isUrgent = isUrgent;
    for (const [key, value] of Object.entries(fields)) set[`automation.${key}`] = value;
    Object.assign(set, rootFields);
    await AutoTaskReservation.updateOne(
        { _id: taskId },
        { $set: set, $push: { 'automation.log': buildLogEntry(status, reason) } }
    );
}

async function loadTaskContext(task) {
    const reservation = await Reservation.findById(task.reservationId).lean();
    if (!reservation) return { task, reservation: null, services: [], payments: [], client: null, service: null };

    const [services, payments, client] = await Promise.all([
        ServiceReservation.find({ reservationId: reservation._id }).lean(),
        PaymentReservation.find({ reservationId: reservation._id }).lean(),
        reservation.clientId ? Client.findById(reservation.clientId).lean() : null
    ]);
    const service = task.serviceId
        ? services.find(item => String(item._id) === String(task.serviceId)) || null
        : null;
    return { task, reservation, services, payments, client, service };
}

async function executeEmailDecision(task, decision) {
    const sendEmail = AUTOMATION_EMAIL_SENDERS[decision.email];
    await sendEmail({ body: { emails: decision.recipients, fields: decision.fields } });
    await logTask(task._id, 'sent', `Email enviado a ${decision.recipients.join(', ')}`);
    await Reservation.updateOne(
        { _id: task.reservationId },
        { $set: { [decision.reservationFlag]: true } }
    );
    const reason = `${decision.reason} a ${decision.recipients.join(', ')}`;
    await updateTaskAutomation(task._id, { status: AUTOMATION_STATUS.EXECUTED, reason, isDone: true });
    return { status: AUTOMATION_STATUS.EXECUTED, reason };
}

async function executeWhatsappDecision(task, decision, context) {
    const { service, reservation } = context;
    const result = await getWhatsappModule().sendConfirmationWhatsapp({ task, service, reservation });
    if (!result?.sent) {
        const reason = `No se pudo enviar el WhatsApp de confirmación: ${result?.reason || 'error desconocido'}. Contactar con el proveedor${getProviderPhoneText(service)}`;
        await updateTaskAutomation(task._id, { status: AUTOMATION_STATUS.MANUAL, reason, isDone: false, isUrgent: true });
        return { status: AUTOMATION_STATUS.MANUAL, reason };
    }

    const sentAt = new Date();
    const reason = `WhatsApp de confirmación enviado el ${formatDateTime(sentAt)}: revisar la respuesta del proveedor`;
    await updateTaskAutomation(task._id, {
        status: AUTOMATION_STATUS.MANUAL,
        reason,
        isDone: false,
        isUrgent: decision.urgent === true,
        fields: { sentAt, sentTo: result.phoneTo || service.providerFinalPhone, sentMessageId: result.messageId }
    });
    return { status: AUTOMATION_STATUS.MANUAL, reason };
}

async function sendHotelEmailAndWait(task, context, toEmail, { resentCount = 0 } = {}) {
    const { service, reservation } = context;
    const sent = await getHotelModule().sendHotelConfirmationEmail({ task, service, reservation, toEmail });
    const sentAt = new Date();
    const reason = `Email de confirmación enviado al hotel (${sent.sentTo}) el ${formatDateTime(sentAt)}: esperando respuesta`;
    await updateTaskAutomation(task._id, {
        status: AUTOMATION_STATUS.WAITING,
        reason,
        isDone: false,
        rootFields: { gmailThreadId: sent.threadId },
        fields: {
            sentAt,
            sentTo: sent.sentTo,
            sentMessageId: sent.rfcMessageId || sent.messageId,
            deadlineAt: getHotelReplyDeadline(service, sentAt),
            resentCount,
            processedMessageIds: []
        }
    });
    return { status: AUTOMATION_STATUS.WAITING, reason };
}

async function markHotelManual(task, service, reason) {
    const fullReason = `${reason}. Llamar al hotel${getProviderPhoneText(service)}`;
    await updateTaskAutomation(task._id, { status: AUTOMATION_STATUS.MANUAL, reason: fullReason, isDone: false, isUrgent: true });
    return { status: AUTOMATION_STATUS.MANUAL, reason: fullReason };
}

async function executeHotelDecision(task, decision, context) {
    const { service, reservation } = context;
    const hotel = getHotelModule();
    const email = hotel.buildHotelConfirmationEmail({ service, reservation });
    if (email.error) {
        const fields = email.missingFields ? ` (${email.missingFields.join(', ')})` : '';
        const reason = `Faltan datos del hotel para enviar la confirmación: ${email.error}${fields}`;
        await updateTaskAutomation(task._id, { status: AUTOMATION_STATUS.MANUAL, reason, isDone: false });
        return { status: AUTOMATION_STATUS.MANUAL, reason };
    }

    let toEmail = decision.toEmail;
    if (!toEmail) {
        const found = await hotel.findAlternativeHotelEmail({ service, reservation, excludeEmails: [] });
        if (!found?.email) return markHotelManual(task, service, 'El hotel no tiene email y no se ha encontrado ninguno');
        toEmail = found.email;
        await logTask(task._id, 'email_found', `Email del hotel encontrado: ${toEmail}${found.sourceUrl ? ` (${found.sourceUrl})` : ''}`);
    }
    return sendHotelEmailAndWait(task, context, toEmail);
}

async function executeDecision(task, decision, context) {
    if (decision.action === 'send') return executeEmailDecision(task, decision);
    if (decision.action === 'sendWhatsapp') return executeWhatsappDecision(task, decision, context);
    if (decision.action === 'sendHotelEmail') return executeHotelDecision(task, decision, context);

    const isDone = decision.action !== AUTOMATION_STATUS.MANUAL;
    await updateTaskAutomation(task._id, {
        status: decision.action,
        reason: decision.reason,
        isDone,
        isUrgent: decision.urgent === true ? true : undefined
    });
    return { status: decision.action, reason: decision.reason };
}

async function processScheduledTask(task, context, now) {
    try {
        const decision = decideAutoTaskAutomation({ ...context, task, now });
        const outcome = await executeDecision(task, decision, context);
        return { task, ...outcome };
    } catch (error) {
        console.error(`Error en la automatización de la auto tarea ${task._id}:`, error);
        const reason = `Error en el envío automático: ${error.message}`;
        await updateTaskAutomation(task._id, { status: AUTOMATION_STATUS.MANUAL, reason, isDone: false });
        return { task, status: AUTOMATION_STATUS.MANUAL, reason };
    }
}

// Tracking of the email to the hotel: reply, bounce or no reply within the deadline.
async function followUpHotelTask(task, context, now) {
    const { service, reservation } = context;
    const automation = task.automation || {};
    if (!service || service.confirmed === true) {
        const reason = 'El servicio ya está confirmado';
        await updateTaskAutomation(task._id, { status: AUTOMATION_STATUS.EXECUTED, reason, isDone: true });
        return { task, status: AUTOMATION_STATUS.EXECUTED, reason };
    }

    const hotel = getHotelModule();
    const followUps = await hotel.findHotelFollowUps({
        task,
        sentAt: automation.sentAt,
        sentTo: automation.sentTo,
        rfcMessageId: automation.sentMessageId,
        threadId: task.gmailThreadId,
        service,
        reservation
    });
    const processedIds = new Set(automation.processedMessageIds || []);
    const newReplies = (followUps.replies || []).filter(reply => !processedIds.has(reply.id));

    if (newReplies.length > 0) {
        const replies = followUps.replies;
        const result = await hotel.classifyHotelReply({ replies, service, reservation });
        const processedMessageIds = replies.map(reply => reply.id);
        if (hotel.isSafeAutoConfirmation(result)) {
            await ServiceReservation.updateOne(
                { _id: service._id },
                { $set: { confirmed: true, ...(result.confirmationNumber ? { hotelConfirmationNumber: result.confirmationNumber } : {}) } }
            );
            const reason = `Hotel confirmado por email${result.confirmationNumber ? ` (nº ${result.confirmationNumber})` : ''}: ${result.summary}`;
            await updateTaskAutomation(task._id, {
                status: AUTOMATION_STATUS.EXECUTED,
                reason,
                isDone: true,
                fields: { summary: result.summary, processedMessageIds, lastCheckedAt: now }
            });
            return { task, status: AUTOMATION_STATUS.EXECUTED, reason };
        }

        const details = [...(result.differences || []), ...(result.missingInfo || [])];
        const reason = `El hotel ha respondido sin confirmar todo (${result.category}): ${result.summary}${details.length ? ` Revisar: ${details.join('; ')}` : ''}`;
        await updateTaskAutomation(task._id, {
            status: AUTOMATION_STATUS.MANUAL,
            reason,
            isDone: false,
            isUrgent: true,
            fields: { summary: result.summary, processedMessageIds, lastCheckedAt: now }
        });
        // Individual notification with buttons to accept or reply to the hotel from Telegram
        const notified = await getTelegramModule().notifyHotelReview({ task, service, reservation, result, replies });
        return { task, status: AUTOMATION_STATUS.MANUAL, reason, notified };
    }

    if (followUps.bounce) {
        const excludeEmails = [automation.sentTo, followUps.bounce.recipient, service.providerFinalEmail].filter(Boolean);
        if ((automation.resentCount || 0) >= MAX_HOTEL_RESENDS) {
            const result = await markHotelManual(task, service, `El email al hotel ha rebotado también en ${automation.sentTo}`);
            return { task, ...result };
        }
        const found = await hotel.findAlternativeHotelEmail({ service, reservation, excludeEmails });
        const alternative = found?.email;
        if (!alternative) {
            const result = await markHotelManual(task, service, `El email al hotel ha rebotado (${automation.sentTo}) y no se ha encontrado otro`);
            return { task, ...result };
        }
        await logTask(task._id, 'bounced', `Rebote de ${automation.sentTo}; se reenvía a ${alternative}`);
        const result = await sendHotelEmailAndWait(task, context, alternative, {
            resentCount: (automation.resentCount || 0) + 1
        });
        return { task, ...result };
    }

    if (automation.deadlineAt && now >= new Date(automation.deadlineAt)) {
        const result = await markHotelManual(task, service, `El hotel no ha respondido desde el ${formatDateTime(automation.sentAt)}`);
        return { task, ...result };
    }

    await AutoTaskReservation.updateOne(
        { _id: task._id },
        { $set: { 'automation.status': AUTOMATION_STATUS.WAITING, 'automation.lastCheckedAt': now } }
    );
    return null;
}

async function processWaitingTask(task, context, now) {
    try {
        return await followUpHotelTask(task, context, now);
    } catch (error) {
        console.error(`Error en el seguimiento de la auto tarea ${task._id}:`, error);
        // Back to waiting: the next cron pass retries it.
        await AutoTaskReservation.updateOne(
            { _id: task._id },
            {
                $set: { 'automation.status': AUTOMATION_STATUS.WAITING },
                $push: { 'automation.log': buildLogEntry('error', `Error al revisar respuestas: ${error.message}`) }
            }
        );
        return null;
    }
}

function formatAutomationSummary(results) {
    const labels = {
        [AUTOMATION_STATUS.EXECUTED]: '✅ Ejecutadas',
        [AUTOMATION_STATUS.WAITING]: '⏳ Esperando respuesta',
        [AUTOMATION_STATUS.MANUAL]: '✋ Manuales',
        [AUTOMATION_STATUS.DISCARDED]: '🗑️ Descartadas'
    };
    const lines = ['🤖 AUTO TAREAS AUTOMÁTICAS'];
    for (const status of Object.keys(labels)) {
        const group = results.filter(result => result.status === status);
        if (group.length === 0) continue;
        lines.push('', `${labels[status]}: ${group.length}`);
        for (const result of group) {
            lines.push(`• ${result.task.title} (${result.task.date}): ${result.reason}`);
        }
    }
    return lines.join('\n');
}

// A task left half-done (process crash) is switched to manual for review:
// it is not retried automatically because the send may already have happened.
async function releaseStuckTasks(now) {
    const limit = new Date(now.getTime() - STUCK_PROCESSING_MINUTES * 60 * 1000);
    const reason = 'La automatización se interrumpió: revisar si el envío llegó a hacerse';
    await AutoTaskReservation.updateMany(
        { 'automation.status': AUTOMATION_STATUS.PROCESSING, 'automation.claimedAt': { $lt: limit } },
        {
            $set: {
                'automation.status': AUTOMATION_STATUS.MANUAL,
                'automation.reason': reason,
                'automation.decidedAt': now
            },
            $push: { 'automation.log': buildLogEntry(AUTOMATION_STATUS.MANUAL, reason) }
        }
    );
}

// Decides the scheduled auto tasks whose time has come and tracks those awaiting
// a reply. Activity and transfer confirmations are decided 24 h before the
// service at any time of day; the rest, from 9:00 (Madrid) on the task's day.
async function runAutoTaskAutomations({ now = new Date() } = {}) {
    await releaseStuckTasks(now);

    const tasks = await AutoTaskReservation.find({
        isDone: false,
        taskType: { $in: AUTOMATED_TASK_TYPES },
        'automation.status': { $in: [AUTOMATION_STATUS.SCHEDULED, AUTOMATION_STATUS.WAITING] }
    }).lean();

    const results = [];
    for (const pendingTask of tasks) {
        if (!isAutomationEnabledForTaskType(pendingTask.taskType)) continue;
        const fromStatus = pendingTask.automation.status;
        // Cheap date filter before loading the service (activity and transfer
        // confirmations are dated the day before the service).
        // One-day margin for time zones ahead of Madrid.
        const dueReference = pendingTask.taskType === 'Confirmation'
            ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
            : now;
        if (fromStatus === AUTOMATION_STATUS.SCHEDULED && !isTaskDue(pendingTask, dueReference)) continue;

        let service = null;
        if (pendingTask.serviceId) {
            service = await ServiceReservation.findById(pendingTask.serviceId).lean();
        }
        if (fromStatus === AUTOMATION_STATUS.SCHEDULED && !isTaskDueForAutomation(pendingTask, service, now)) continue;

        const task = await claimTask(pendingTask._id, fromStatus);
        if (!task) continue;
        const context = await loadTaskContext(task);

        const result = fromStatus === AUTOMATION_STATUS.SCHEDULED
            ? await processScheduledTask(task, context, now)
            : await processWaitingTask(task, context, now);
        if (result) results.push(result);
    }

    // Hotel replies already notified in their own message are not repeated in the summary
    const summaryResults = results.filter(result => !result.notified);
    if (summaryResults.length > 0) {
        notificationAdmin.sendNotificationAdmin(
            formatAutomationSummary(summaryResults),
            true, false, null, null, {}, false
        );
    }
    return results;
}

module.exports = {
    formatAutomationSummary,
    isWithinAutomationWindow,
    runAutoTaskAutomations
};
