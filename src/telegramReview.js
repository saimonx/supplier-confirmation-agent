'use strict';

const crypto = require('crypto');

// Hotel replies pending review, handled from Telegram:
// - "Aceptar confirmación" button or an "OK" reply → service confirmed and task closed.
// - Any other text in reply to the notice → operator instructions. OpenAI drafts the
//   email in the hotel's language and it is shown as a draft with "Enviar", "Rehacer" and "Cancelar".
//   It is only emailed to the hotel (in its thread) when the operator presses "Enviar"; then the
//   task goes back to waiting for a reply. Nothing is ever sent without that explicit confirmation.

const CALLBACK_PATTERN = /^ath:(ok|reply|send|redo|cancel):([a-f0-9]{18})(?::([a-f0-9]{8}))?$/;
const DRAFT_ACTIONS = ['send', 'redo', 'cancel'];
const MAX_STORED_REPLY_TEXT = 6000;
// Telegram message types linked to the task
const MESSAGE_KIND = { NOTICE: 'notice', PROMPT: 'prompt', DRAFT: 'draft', REDO: 'redo' };
const ACCEPT_WORDS = ['ok', 'okay', 'okey', 'vale', 'si', 'sí', 'aceptar', 'aceptada', 'confirmar', 'confirmada', 'confirmado', '👍', '✅'];
const MAX_REVIEW_ITEMS = 8;

// Lazy loading: models, Gmail and Telegram need configuration; pure functions are tested without them.
function getModels() {
    return require('./adapters/models');
}
function getHotelModule() {
    return require('./hotelAgent');
}
function getNotificationAdmin() {
    return require('./adapters/notificationAdmin');
}
function getAutomationRules() {
    return require('./automationRules');
}
function getHotelRules() {
    return require('./hotelRules');
}

function createTelegramToken() {
    return crypto.randomBytes(9).toString('hex');
}

function buildCallbackData(action, token, draftId = null) {
    return `ath:${action}:${token}${draftId ? `:${draftId}` : ''}`;
}

function parseCallbackData(data) {
    const match = CALLBACK_PATTERN.exec(String(data || ''));
    if (!match) return null;
    const [, action, token, draftId = null] = match;
    // Send, redo and cancel are always tied to a specific draft
    if (DRAFT_ACTIONS.includes(action) !== Boolean(draftId)) return null;
    return { action, token, draftId };
}

function buildReplyDraftKeyboard(token, draftId) {
    return {
        inline_keyboard: [
            [{ text: '📤 Enviar al hotel', callback_data: buildCallbackData('send', token, draftId) }],
            [
                { text: '✏️ Rehacer', callback_data: buildCallbackData('redo', token, draftId) },
                { text: '❌ Cancelar', callback_data: buildCallbackData('cancel', token, draftId) }
            ]
        ]
    };
}

function isAcceptText(text) {
    const normalized = String(text || '').trim().toLowerCase().replace(/[.!¡,;:\s]+$/g, '').replace(/^[¡\s]+/, '');
    return ACCEPT_WORDS.includes(normalized);
}

function buildHotelReviewKeyboard(token) {
    return {
        inline_keyboard: [[
            { text: '✅ Aceptar confirmación', callback_data: buildCallbackData('ok', token) },
            { text: '✉️ Responder al hotel', callback_data: buildCallbackData('reply', token) }
        ]]
    };
}

function formatHotelReviewMessage({ task, service, reservation, result, replyFrom }) {
    const svc = service || {};
    const items = [...(result.differences || []), ...(result.missingInfo || [])].slice(0, MAX_REVIEW_ITEMS);
    const lines = [
        '🏨 RESPUESTA DE HOTEL A REVISAR',
        `${svc.title || task.title}${svc.dateStart ? ` (${svc.dateStart}${svc.dateEnd ? ` - ${svc.dateEnd}` : ''})` : ''}`
    ];
    if (reservation && reservation.clientsNames) lines.push(`Clientes: ${reservation.clientsNames}`);
    if (replyFrom) lines.push(`De: ${replyFrom}`);
    lines.push(`Tipo: ${result.category}`);
    if (result.confirmationNumber) lines.push(`Nº confirmación: ${result.confirmationNumber}`);
    lines.push('', result.summary || '(sin resumen)');
    if (items.length > 0) {
        lines.push('', 'Revisar:', ...items.map(item => `• ${item}`));
    }
    lines.push(
        '',
        '✅ Pulsa «Aceptar confirmación» o responde «OK» para dar el hotel por confirmado y cerrar la tarea.',
        '✉️ Responde a este mensaje con lo que quieres decir al hotel: se redactará un borrador en su idioma y solo se enviará si pulsas «Enviar».'
    );
    return lines.join('\n');
}

function getReplyRecipient(automation = {}) {
    return automation.replyFrom || automation.sentTo || null;
}

async function findTaskByToken(token) {
    const { AutoTaskReservation } = getModels();
    return AutoTaskReservation.findOne({ 'automation.telegramToken': token }).lean();
}

async function findTaskByTelegramMessage(chatId, messageId) {
    const { AutoTaskReservation } = getModels();
    return AutoTaskReservation.findOne({
        'automation.telegramMessages': { $elemMatch: { chatId: `${chatId}`, messageId: Number(messageId) } }
    }).lean();
}

function getTelegramMessageKind(task, chatId, messageId) {
    const message = ((task.automation || {}).telegramMessages || [])
        .find(item => item.chatId === `${chatId}` && Number(item.messageId) === Number(messageId));
    return (message && message.kind) || MESSAGE_KIND.NOTICE;
}

async function rememberTelegramMessages(taskId, receipts, kind = MESSAGE_KIND.NOTICE) {
    const messages = (receipts || [])
        .filter(receipt => receipt && receipt.chatId !== undefined && receipt.messageId !== undefined)
        .map(receipt => ({ chatId: `${receipt.chatId}`, messageId: Number(receipt.messageId), kind }));
    if (messages.length === 0) return;
    const { AutoTaskReservation } = getModels();
    await AutoTaskReservation.updateOne(
        { _id: taskId },
        { $push: { 'automation.telegramMessages': { $each: messages } } }
    );
}

/**
 * Sends the individual notice with buttons for a hotel reply that requires review
 * and stores on the task what is needed to accept it or reply from Telegram.
 * @returns {Promise<boolean>} true if the notice was sent
 */
async function notifyHotelReview({ task, service, reservation, result, replies = [] }) {
    const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
    const replyFrom = (lastReply && lastReply.fromEmail) || null;
    const token = createTelegramToken();
    const { AutoTaskReservation } = getModels();
    await AutoTaskReservation.updateOne(
        { _id: task._id },
        {
            $set: {
                'automation.telegramToken': token,
                'automation.confirmationNumber': result.confirmationNumber || null,
                'automation.replyFrom': replyFrom,
                'automation.replyThreadId': (lastReply && lastReply.threadId) || task.gmailThreadId || null,
                'automation.replyText': lastReply ? String(lastReply.textBody || '').slice(0, MAX_STORED_REPLY_TEXT) : null
            }
        }
    );

    try {
        const text = formatHotelReviewMessage({ task, service, reservation, result, replyFrom });
        const { receipts } = await getNotificationAdmin().sendCommunicationsTelegramMessage(text, {
            reply_markup: buildHotelReviewKeyboard(token)
        });
        await rememberTelegramMessages(task._id, receipts);
        return true;
    } catch (error) {
        console.error(`[autotask-telegram] No se pudo enviar el aviso de la tarea ${task._id}:`, error.message);
        return false;
    }
}

function buildLogEntry(action, detail) {
    return { at: new Date(), action, detail };
}

/**
 * Accepts the hotel's reply: service confirmed and task closed.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function acceptHotelConfirmation(task, { by = 'Telegram' } = {}) {
    const { AutoTaskReservation, ServiceReservation } = getModels();
    const { AUTOMATION_STATUS } = getAutomationRules();
    const automation = task.automation || {};
    const confirmationNumber = automation.confirmationNumber || null;
    const reason = `Confirmación del hotel aceptada manualmente desde ${by}${confirmationNumber ? ` (nº ${confirmationNumber})` : ''}`;

    const updated = await AutoTaskReservation.findOneAndUpdate(
        { _id: task._id, isDone: false, 'automation.status': { $ne: AUTOMATION_STATUS.PROCESSING } },
        {
            $set: {
                isDone: true,
                isUrgent: false,
                'automation.status': AUTOMATION_STATUS.EXECUTED,
                'automation.reason': reason,
                'automation.decidedAt': new Date()
            },
            $push: { 'automation.log': buildLogEntry(AUTOMATION_STATUS.EXECUTED, reason) }
        },
        { returnDocument: 'after' }
    ).lean();

    if (!updated) {
        const current = await AutoTaskReservation.findById(task._id).lean();
        if (current && current.isDone) return { ok: false, message: 'ℹ️ La tarea ya estaba cerrada.' };
        return { ok: false, message: '⏳ La tarea se está procesando ahora mismo; inténtalo de nuevo en un minuto.' };
    }

    if (task.serviceId) {
        const service = await ServiceReservation.findById(task.serviceId).lean();
        const set = { confirmed: true };
        if (confirmationNumber && !(service && service.hotelConfirmationNumber)) {
            set.hotelConfirmationNumber = confirmationNumber;
        }
        await ServiceReservation.updateOne({ _id: task.serviceId }, { $set: set });
    }
    return { ok: true, message: `✅ Hotel confirmado y tarea cerrada${confirmationNumber ? ` (nº ${confirmationNumber})` : ''}.` };
}

/**
 * Drafts the email to the hotel with OpenAI from the operator's instructions (or corrects the
 * current draft) and saves it as a draft, replacing the previous one. Sends nothing.
 * @param {object} task
 * @param {{instructions?: string, corrections?: string}} params
 * @returns {Promise<{ok: boolean, message: string, draftId?: string, toEmail?: string, text?: string}>}
 */
async function createReplyDraft(task, { instructions = '', corrections = '' } = {}, deps = {}) {
    const { AutoTaskReservation, ServiceReservation, Reservation } = getModels();
    if (task.isDone) {
        return { ok: false, message: 'ℹ️ La tarea ya está cerrada: no se prepara ningún email.' };
    }
    const automation = task.automation || {};
    const toEmail = getReplyRecipient(automation);
    if (!toEmail) {
        return { ok: false, message: '⚠️ No hay email del hotel al que responder.' };
    }
    const previous = corrections ? automation.replyDraft : null;
    if (corrections && !(previous && previous.text)) {
        return { ok: false, message: 'ℹ️ No hay ningún borrador pendiente que corregir. Responde al aviso del hotel con lo que quieres decir.' };
    }

    const [service, reservation] = await Promise.all([
        task.serviceId ? ServiceReservation.findById(task.serviceId).lean() : null,
        task.reservationId ? Reservation.findById(task.reservationId).lean() : null
    ]);
    const svc = service || {};
    const lang = getHotelRules().detectHotelEmailLanguage(svc.providerFinalPhone, {
        timeZone: svc.dateStartTimeZone,
        email: toEmail
    });
    const operatorInstructions = previous ? (previous.instructions || previous.text) : instructions;
    const text = await (deps.hotel || getHotelModule()).draftHotelReplyEmail({
        instructions: operatorInstructions,
        service: svc,
        reservation,
        lang,
        hotelReplyText: automation.replyText || '',
        previousDraft: previous ? previous.text : '',
        corrections
    });

    const draftId = crypto.randomBytes(4).toString('hex');
    const storedInstructions = previous
        ? `${operatorInstructions}\n\nCambios: ${corrections}`
        : operatorInstructions;
    await AutoTaskReservation.updateOne(
        { _id: task._id },
        { $set: { 'automation.replyDraft': { id: draftId, text, instructions: storedInstructions, lang, createdAt: new Date() } } }
    );
    return { ok: true, draftId, toEmail, text, lang, message: '' };
}

function formatReplyDraftMessage(task, toEmail, text, lang) {
    return [
        `📝 BORRADOR para ${toEmail} (${task.title}) · ${lang === 'en' ? 'inglés' : 'español'}`,
        '',
        text,
        '',
        '— firma de NomadFlight —',
        '',
        'No se enviará nada hasta que pulses «📤 Enviar al hotel».',
        '✏️ Para cambiarlo, pulsa «Rehacer» o responde a este mensaje con los cambios.'
    ].join('\n');
}

/**
 * Sends the confirmed draft. It is claimed atomically so it is not sent twice.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function sendReplyDraft(task, draftId) {
    const { AutoTaskReservation } = getModels();
    const claimed = await AutoTaskReservation.findOneAndUpdate(
        { _id: task._id, 'automation.replyDraft.id': draftId },
        { $unset: { 'automation.replyDraft': '' } },
        { returnDocument: 'before' }
    ).lean();
    const draft = claimed && claimed.automation && claimed.automation.replyDraft;
    if (!draft || !draft.text) {
        return { ok: false, message: 'ℹ️ Este borrador ya se envió, se canceló o se sustituyó por otro.' };
    }
    try {
        const result = await replyToHotel(claimed, draft.text);
        if (!result.ok) await restoreReplyDraft(task._id, draft);
        return result;
    } catch (error) {
        await restoreReplyDraft(task._id, draft);
        throw error;
    }
}

async function restoreReplyDraft(taskId, draft) {
    const { AutoTaskReservation } = getModels();
    await AutoTaskReservation.updateOne(
        { _id: taskId, 'automation.replyDraft': { $exists: false } },
        { $set: { 'automation.replyDraft': draft } }
    );
}

async function cancelReplyDraft(task, draftId) {
    const { AutoTaskReservation } = getModels();
    const claimed = await AutoTaskReservation.findOneAndUpdate(
        { _id: task._id, 'automation.replyDraft.id': draftId },
        { $unset: { 'automation.replyDraft': '' } },
        { returnDocument: 'before' }
    ).lean();
    return claimed
        ? { ok: true, message: '❌ Borrador cancelado: no se ha enviado nada al hotel.' }
        : { ok: false, message: 'ℹ️ Este borrador ya se envió, se canceló o se sustituyó por otro.' };
}

/**
 * Replies to the hotel by email with the operator's text and waits for its reply again.
 * Only called from sendReplyDraft, after the operator's explicit confirmation.
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function replyToHotel(task, text) {
    const { AutoTaskReservation, ServiceReservation } = getModels();
    const { AUTOMATION_STATUS, getHotelReplyDeadline } = getAutomationRules();
    const automation = task.automation || {};
    if (task.isDone) {
        return { ok: false, message: 'ℹ️ La tarea ya está cerrada: no se ha enviado el email.' };
    }
    if (automation.status === AUTOMATION_STATUS.PROCESSING) {
        return { ok: false, retry: true, message: '⏳ La tarea se está procesando ahora mismo; pulsa «Enviar» de nuevo en un minuto.' };
    }
    const toEmail = getReplyRecipient(automation);
    if (!toEmail) {
        return { ok: false, message: '⚠️ No hay email del hotel al que responder.' };
    }

    const sent = await getHotelModule().sendHotelReplyEmail({
        toEmail,
        threadId: automation.replyThreadId || task.gmailThreadId || null,
        text
    });
    // The email has already gone out: a save failure must not allow it to be resent
    try {
        const service = task.serviceId ? await ServiceReservation.findById(task.serviceId).lean() : null;
        const reason = `Respuesta enviada al hotel (${sent.sentTo}) desde Telegram: esperando respuesta`;
        await AutoTaskReservation.updateOne(
            { _id: task._id },
            {
                $set: {
                    isDone: false,
                    isUrgent: false,
                    gmailThreadId: sent.threadId || task.gmailThreadId,
                    'automation.status': AUTOMATION_STATUS.WAITING,
                    'automation.reason': reason,
                    'automation.decidedAt': new Date(),
                    'automation.sentAt': sent.sentAt,
                    'automation.sentTo': sent.sentTo,
                    'automation.sentMessageId': sent.rfcMessageId || sent.messageId,
                    'automation.deadlineAt': getHotelReplyDeadline(service, sent.sentAt)
                },
                $push: { 'automation.log': buildLogEntry('telegram_reply', `${reason}. Texto: ${String(text).slice(0, 500)}`) }
            }
        );
    } catch (error) {
        console.error(`[autotask-telegram] Email enviado pero no se pudo actualizar la tarea ${task._id}:`, error);
        return { ok: true, message: `✅ Email enviado a ${sent.sentTo}, pero no se pudo actualizar la tarea (${error.message}). Revísala en el panel.` };
    }
    return { ok: true, message: `✅ Email enviado a ${sent.sentTo}. La tarea vuelve a esperar la respuesta del hotel.` };
}

async function safeSend(bot, chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (error) {
        console.error('[autotask-telegram] Error al enviar mensaje:', error.message);
        return null;
    }
}

/**
 * Notice buttons. Returns false if the callback does not belong to auto tasks.
 */
async function handleCallbackQuery(callbackQuery, { bot, isAuthorizedChat }) {
    const parsed = parseCallbackData(callbackQuery && callbackQuery.data);
    if (!parsed) return false;
    const message = callbackQuery.message || {};
    const chatId = message.chat && message.chat.id;
    const answer = text => bot.answerCallbackQuery(callbackQuery.id, { text }).catch(() => null);

    if (!isAuthorizedChat(chatId)) {
        await answer('Chat no autorizado');
        return true;
    }
    const task = await findTaskByToken(parsed.token);
    if (!task) {
        await answer('Tarea no encontrada');
        return true;
    }

    if (parsed.action === 'ok') {
        const result = await acceptHotelConfirmation(task);
        await answer(result.ok ? 'Tarea cerrada' : 'Sin cambios');
        if (result.ok || task.isDone) {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => null);
        }
        await safeSend(bot, chatId, result.message, { reply_to_message_id: message.message_id });
        return true;
    }

    if (parsed.action === 'redo') {
        const draft = (task.automation || {}).replyDraft;
        if (!draft || draft.id !== parsed.draftId) {
            await answer('Sin cambios');
            await safeSend(bot, chatId, 'ℹ️ Este borrador ya se envió, se canceló o se sustituyó por otro.', { reply_to_message_id: message.message_id });
            return true;
        }
        await answer('Escribe los cambios');
        const prompt = await safeSend(
            bot,
            chatId,
            `✏️ Escribe qué quieres cambiar del borrador para ${task.title} respondiendo a este mensaje.`,
            { reply_to_message_id: message.message_id, reply_markup: { force_reply: true, selective: true } }
        );
        if (prompt) await rememberTelegramMessages(task._id, [{ chatId, messageId: prompt.message_id }], MESSAGE_KIND.REDO);
        return true;
    }

    if (parsed.action === 'send' || parsed.action === 'cancel') {
        let result;
        try {
            result = parsed.action === 'send'
                ? await sendReplyDraft(task, parsed.draftId)
                : await cancelReplyDraft(task, parsed.draftId);
        } catch (error) {
            console.error(`[autotask-telegram] Error al enviar el borrador de la tarea ${task._id}:`, error);
            result = { ok: false, retry: true, message: `❌ Error al enviar: ${error.message}. El borrador sigue pendiente.` };
        }
        await answer(result.ok ? (parsed.action === 'send' ? 'Enviado' : 'Cancelado') : 'Sin cambios');
        // If it can be retried, the draft buttons are kept
        if (!result.retry) {
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => null);
        }
        await safeSend(bot, chatId, result.message, { reply_to_message_id: message.message_id });
        return true;
    }

    // Reply: forced-reply message linked to the same task
    await answer('Escribe la respuesta');
    const toEmail = getReplyRecipient(task.automation);
    const prompt = await safeSend(
        bot,
        chatId,
        `✉️ Escribe lo que quieres decir a ${task.title}${toEmail ? ` (${toEmail})` : ''} respondiendo a este mensaje. Se redactará un borrador en su idioma y solo se enviará si pulsas «Enviar».`,
        { reply_to_message_id: message.message_id, reply_markup: { force_reply: true, selective: true } }
    );
    if (prompt) await rememberTelegramMessages(task._id, [{ chatId, messageId: prompt.message_id }], MESSAGE_KIND.PROMPT);
    return true;
}

/**
 * Text reply to an auto task notice. Returns false if the quoted message is not a notice.
 */
async function handleTelegramReply(msg, { bot, isAuthorizedChat }) {
    if (!msg || !msg.reply_to_message) return false;
    const chatId = msg.chat && msg.chat.id;
    const task = await findTaskByTelegramMessage(chatId, msg.reply_to_message.message_id);
    if (!task) return false;

    const reply = text => safeSend(bot, chatId, text, { reply_to_message_id: msg.message_id });
    if (!isAuthorizedChat(chatId)) {
        await reply('⚠️ Chat no autorizado.');
        return true;
    }
    const text = String(msg.text || '').trim();
    if (!text) {
        await reply('⚠️ Solo se pueden enviar respuestas de texto al hotel.');
        return true;
    }

    const kind = getTelegramMessageKind(task, chatId, msg.reply_to_message.message_id);
    const isCorrection = kind === MESSAGE_KIND.DRAFT || kind === MESSAGE_KIND.REDO;
    try {
        if (isAcceptText(text)) {
            if (isCorrection) {
                await reply('ℹ️ Para enviar el borrador pulsa «📤 Enviar al hotel». Para aceptar la confirmación del hotel, responde «OK» al aviso.');
                return true;
            }
            const result = await acceptHotelConfirmation(task);
            await reply(result.message);
            return true;
        }
        if (task.isDone) {
            await reply('ℹ️ La tarea ya está cerrada: no se prepara ningún email.');
            return true;
        }
        // Never sent directly: OpenAI writes a draft with confirmation buttons
        await reply('⏳ Redactando el borrador…');
        const draft = await createReplyDraft(task, isCorrection ? { corrections: text } : { instructions: text });
        if (!draft.ok) {
            await reply(draft.message);
            return true;
        }
        const sent = await safeSend(bot, chatId, formatReplyDraftMessage(task, draft.toEmail, draft.text, draft.lang), {
            reply_to_message_id: msg.message_id,
            reply_markup: buildReplyDraftKeyboard(task.automation.telegramToken, draft.draftId)
        });
        if (sent) await rememberTelegramMessages(task._id, [{ chatId, messageId: sent.message_id }], MESSAGE_KIND.DRAFT);
    } catch (error) {
        console.error(`[autotask-telegram] Error al procesar la respuesta de la tarea ${task._id}:`, error);
        await reply(`❌ Error: ${error.message}`);
    }
    return true;
}

module.exports = {
    acceptHotelConfirmation,
    buildCallbackData,
    cancelReplyDraft,
    createReplyDraft,
    buildHotelReviewKeyboard,
    formatHotelReviewMessage,
    handleCallbackQuery,
    handleTelegramReply,
    isAcceptText,
    notifyHotelReview,
    parseCallbackData,
    sendReplyDraft
};
