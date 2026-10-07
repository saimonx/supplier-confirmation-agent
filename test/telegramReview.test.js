const assert = require('assert');
const path = require('path');

// Model, Gmail and Telegram doubles before loading the module
const tasks = new Map();
const services = new Map();
const sentEmails = [];
const telegramSends = [];

function lean(value) {
    return { lean: async () => (value ? JSON.parse(JSON.stringify(value)) : null) };
}
function matchesTask(task, query) {
    if (query._id && String(query._id) !== String(task._id)) return false;
    if (query.isDone === false && task.isDone) return false;
    if (query['automation.status'] && query['automation.status'].$ne === task.automation.status) return false;
    if (query['automation.telegramToken'] && query['automation.telegramToken'] !== task.automation.telegramToken) return false;
    if (query['automation.replyDraft.id'] && query['automation.replyDraft.id'] !== (task.automation.replyDraft || {}).id) return false;
    if (query['automation.replyDraft'] && query['automation.replyDraft'].$exists === false && task.automation.replyDraft) return false;
    const elem = query['automation.telegramMessages'];
    if (elem) {
        const { chatId, messageId } = elem.$elemMatch;
        return (task.automation.telegramMessages || []).some(m => m.chatId === chatId && m.messageId === messageId);
    }
    return true;
}
function walk(doc, key) {
    const parts = key.split('.');
    let target = doc;
    for (const part of parts.slice(0, -1)) {
        if (!target[part]) target[part] = {};
        target = target[part];
    }
    return { target, last: parts[parts.length - 1] };
}
function applyUpdate(doc, update) {
    for (const [key, value] of Object.entries(update.$set || {})) {
        const { target, last } = walk(doc, key);
        target[last] = value;
    }
    for (const key of Object.keys(update.$unset || {})) {
        const { target, last } = walk(doc, key);
        delete target[last];
    }
    for (const [key, value] of Object.entries(update.$push || {})) {
        const { target, last } = walk(doc, key);
        const list = target[last] = target[last] || [];
        if (value && value.$each) list.push(...value.$each); else list.push(value);
    }
}
const AutoTaskReservation = {
    findOne: query => lean([...tasks.values()].find(task => matchesTask(task, query))),
    findById: id => lean(tasks.get(String(id))),
    findOneAndUpdate: (query, update, options = {}) => {
        const task = [...tasks.values()].find(item => matchesTask(item, query));
        const before = task ? JSON.parse(JSON.stringify(task)) : null;
        if (task) applyUpdate(task, update);
        return lean(options.returnDocument === 'before' ? before : task);
    },
    updateOne: async (query, update) => { const task = tasks.get(String(query._id)); if (task) applyUpdate(task, update); }
};
const ServiceReservation = {
    findById: id => lean(services.get(String(id))),
    updateOne: async (query, update) => { applyUpdate(services.get(String(query._id)), update); }
};

function stub(relativePath, exportsValue) {
    const resolved = require.resolve(path.join(__dirname, '..', relativePath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}
const Reservation = { findById: () => lean({ _id: 'r1', clientsNames: 'Ana Pérez', adults: 2 }) };
stub('src/adapters/models.js', { AutoTaskReservation, ServiceReservation, Reservation });
const draftCalls = [];
stub('src/hotelAgent.js', {
    draftHotelReplyEmail: async params => {
        draftCalls.push(params);
        return params.corrections
            ? `Dear team,\n\nCould you confirm early check-in at 8:00? (${params.corrections})\n\nBest regards,`
            : 'Dear team,\n\nCould you confirm early check-in at 9:00?\n\nBest regards,';
    },
    sendHotelReplyEmail: async params => {
        sentEmails.push(params);
        return { threadId: 'thread-2', messageId: 'gm-2', rfcMessageId: '<r2@x>', sentTo: params.toEmail, sentAt: new Date('2026-10-02T10:00:00Z') };
    }
});
stub('src/adapters/notificationAdmin.js', {
    sendCommunicationsTelegramMessage: async (text, options) => {
        telegramSends.push({ text, options });
        return { receipts: [{ chatId: 111, messageId: 500 }] };
    }
});

const telegram = require('../src/telegramReview');

let nextId = 900;
function fakeBot() {
    const calls = { sent: [], answers: [], edits: [] };
    return {
        calls,
        sendMessage: async (chatId, text, options) => { calls.sent.push({ chatId, text, options }); return { message_id: nextId++ }; },
        answerCallbackQuery: async (id, options) => { calls.answers.push(options.text); },
        editMessageReplyMarkup: async (markup, options) => { calls.edits.push(options); }
    };
}
const isAuthorizedChat = chatId => `${chatId}` === '111';

function resetTask() {
    tasks.clear();
    services.clear();
    sentEmails.length = 0;
    telegramSends.length = 0;
    draftCalls.length = 0;
    services.set('s1', { _id: 's1', title: 'Hotel Andes Cusco', dateStart: '30/10/2026', dateEnd: '01/11/2026', confirmed: false, dateStartTimeZone: 'America/Sao_Paulo' });
    tasks.set('t1', {
        _id: 't1', serviceId: 's1', reservationId: 'r1', title: 'Confirmación Hotel Andes Cusco', isDone: false, gmailThreadId: 'thread-1',
        automation: { status: 'manual', sentTo: 'reservas@hotel.pe', processedMessageIds: ['m1'] }
    });
}

async function main() {
    // Pure functions
    assert.strictEqual(telegram.isAcceptText(' OK '), true);
    assert.strictEqual(telegram.isAcceptText('Vale.'), true);
    assert.strictEqual(telegram.isAcceptText('👍'), true);
    assert.strictEqual(telegram.isAcceptText('ok, pero pregunta por el early check-in'), false);
    assert.deepStrictEqual(telegram.parseCallbackData(telegram.buildCallbackData('ok', 'a1b2c3d4e5f6a7b8c9')), { action: 'ok', token: 'a1b2c3d4e5f6a7b8c9', draftId: null });
    assert.strictEqual(telegram.parseCallbackData('ath:ok:../x'), null);
    assert.ok(Buffer.byteLength(telegram.buildCallbackData('reply', 'a1b2c3d4e5f6a7b8c9')) <= 64);

    // Notice: stores token, sender, thread and Telegram messages
    resetTask();
    const result = { category: 'discrepancy', confirmationNumber: '17298/2026', differences: ['Early check-in sin confirmar'], missingInfo: [], summary: 'Confirma con cama King.' };
    const notified = await telegram.notifyHotelReview({
        task: tasks.get('t1'), service: services.get('s1'), reservation: { clientsNames: 'Ana Pérez' }, result,
        replies: [{ id: 'm1', fromEmail: 'front@hotel.pe', threadId: 'thread-1b', textBody: 'We confirm with King bed.' }]
    });
    assert.strictEqual(notified, true);
    const stored = tasks.get('t1').automation;
    assert.match(stored.telegramToken, /^[a-f0-9]{18}$/);
    assert.strictEqual(stored.replyFrom, 'front@hotel.pe');
    assert.strictEqual(stored.replyThreadId, 'thread-1b');
    assert.strictEqual(stored.replyText, 'We confirm with King bed.');
    assert.deepStrictEqual(stored.telegramMessages, [{ chatId: '111', messageId: 500, kind: 'notice' }]);
    assert.match(telegramSends[0].text, /RESPUESTA DE HOTEL A REVISAR/);
    assert.match(telegramSends[0].text, /Early check-in sin confirmar/);
    assert.strictEqual(telegramSends[0].options.reply_markup.inline_keyboard[0].length, 2);

    // Unauthorized chat: nothing changes
    let bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cb0', data: telegram.buildCallbackData('ok', stored.telegramToken), message: { chat: { id: 222 }, message_id: 500 } }, { bot, isAuthorizedChat });
    assert.deepStrictEqual(bot.calls.answers, ['Chat no autorizado']);
    assert.strictEqual(tasks.get('t1').isDone, false);

    // Callback unrelated to auto tasks
    assert.strictEqual(await telegram.handleCallbackQuery({ id: 'x', data: 'otra:cosa' }, { bot, isAuthorizedChat }), false);

    // Text reply → draft only; nothing is sent to the hotel
    bot = fakeBot();
    const handledText = await telegram.handleTelegramReply({
        chat: { id: 111 }, message_id: 601, text: '¿Pueden confirmar el early check-in a las 9:00?', reply_to_message: { message_id: 500 }
    }, { bot, isAuthorizedChat });
    assert.strictEqual(handledText, true);
    assert.strictEqual(sentEmails.length, 0);
    // OpenAI receives the instructions, the hotel's language (Brazil → English) and its latest reply
    assert.strictEqual(draftCalls[0].instructions, '¿Pueden confirmar el early check-in a las 9:00?');
    assert.strictEqual(draftCalls[0].lang, 'en');
    assert.strictEqual(draftCalls[0].hotelReplyText, 'We confirm with King bed.');
    assert.strictEqual(draftCalls[0].reservation.clientsNames, 'Ana Pérez');
    let task = tasks.get('t1');
    assert.strictEqual(task.automation.status, 'manual');
    const firstDraftId = task.automation.replyDraft.id;
    assert.match(firstDraftId, /^[a-f0-9]{8}$/);
    assert.match(bot.calls.sent[0].text, /Redactando/);
    assert.match(bot.calls.sent[1].text, /BORRADOR para front@hotel\.pe .*inglés/);
    assert.match(bot.calls.sent[1].text, /Could you confirm early check-in at 9:00/);
    assert.match(bot.calls.sent[1].text, /No se enviará nada hasta que pulses/);
    assert.ok(task.automation.telegramMessages.some(m => m.kind === 'draft'));
    const draftKeyboard = bot.calls.sent[1].options.reply_markup.inline_keyboard;
    const draftButtons = [draftKeyboard[0][0], draftKeyboard[1][1]];
    const redoButton = draftKeyboard[1][0];
    assert.deepStrictEqual(telegram.parseCallbackData(draftButtons[0].callback_data), { action: 'send', token: stored.telegramToken, draftId: firstDraftId });
    assert.deepStrictEqual(telegram.parseCallbackData(redoButton.callback_data), { action: 'redo', token: stored.telegramToken, draftId: firstDraftId });
    // "OK" in reply to the draft neither sends nor closes the task
    const draftMessageId = task.automation.telegramMessages.find(m => m.kind === 'draft').messageId;
    bot = fakeBot();
    await telegram.handleTelegramReply({ chat: { id: 111 }, message_id: 650, text: 'ok', reply_to_message: { message_id: draftMessageId } }, { bot, isAuthorizedChat });
    assert.strictEqual(sentEmails.length, 0);
    assert.strictEqual(tasks.get('t1').isDone, false);
    assert.match(bot.calls.sent[0].text, /pulsa «📤 Enviar al hotel»/);
    // Send/cancel without a draft are not valid
    assert.strictEqual(telegram.parseCallbackData(`ath:send:${stored.telegramToken}`), null);

    // Cancel the draft: it is not sent
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cbc', data: draftButtons[1].callback_data, message: { chat: { id: 111 }, message_id: 700 } }, { bot, isAuthorizedChat });
    assert.deepStrictEqual(bot.calls.answers, ['Cancelado']);
    assert.strictEqual(sentEmails.length, 0);
    assert.strictEqual(tasks.get('t1').automation.replyDraft, undefined);

    // Pressing "Send" on a cancelled draft: it is not sent
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cbs0', data: draftButtons[0].callback_data, message: { chat: { id: 111 }, message_id: 700 } }, { bot, isAuthorizedChat });
    assert.strictEqual(sentEmails.length, 0);
    assert.match(bot.calls.sent[0].text, /ya se envió, se canceló o se sustituyó/);

    // New draft, "Redo" with changes and "Send" → email to the hotel in its thread
    bot = fakeBot();
    await telegram.handleTelegramReply({
        chat: { id: 111 }, message_id: 602, text: '¿Pueden confirmar el early check-in a las 9:00?', reply_to_message: { message_id: 500 }
    }, { bot, isAuthorizedChat });
    const secondKeyboard = bot.calls.sent[1].options.reply_markup.inline_keyboard;
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cbr', data: secondKeyboard[1][0].callback_data, message: { chat: { id: 111 }, message_id: 702 } }, { bot, isAuthorizedChat });
    assert.strictEqual(bot.calls.sent[0].options.reply_markup.force_reply, true);
    const redoPromptId = tasks.get('t1').automation.telegramMessages.filter(m => m.kind === 'redo').pop().messageId;
    bot = fakeBot();
    await telegram.handleTelegramReply({ chat: { id: 111 }, message_id: 603, text: 'mejor a las 8', reply_to_message: { message_id: redoPromptId } }, { bot, isAuthorizedChat });
    const lastDraftCall = draftCalls[draftCalls.length - 1];
    assert.strictEqual(lastDraftCall.corrections, 'mejor a las 8');
    assert.strictEqual(lastDraftCall.instructions, '¿Pueden confirmar el early check-in a las 9:00?');
    assert.match(lastDraftCall.previousDraft, /9:00/);
    assert.match(bot.calls.sent[1].text, /8:00/);
    // The previous draft can no longer be sent
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cbold', data: secondKeyboard[0][0].callback_data, message: { chat: { id: 111 }, message_id: 702 } }, { bot, isAuthorizedChat });
    assert.strictEqual(sentEmails.length, 0);
    bot = fakeBot();
    await telegram.handleTelegramReply({ chat: { id: 111 }, message_id: 604, text: 'mejor a las 8', reply_to_message: { message_id: redoPromptId } }, { bot, isAuthorizedChat });
    const sendData = bot.calls.sent[1].options.reply_markup.inline_keyboard[0][0].callback_data;
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cbs1', data: sendData, message: { chat: { id: 111 }, message_id: 701 } }, { bot, isAuthorizedChat });
    assert.deepStrictEqual(bot.calls.answers, ['Enviado']);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].toEmail, 'front@hotel.pe');
    assert.strictEqual(sentEmails[0].threadId, 'thread-1b');
    assert.match(sentEmails[0].text, /early check-in at 8:00/);
    task = tasks.get('t1');
    assert.strictEqual(task.automation.status, 'waiting');
    assert.strictEqual(task.isDone, false);
    assert.strictEqual(task.gmailThreadId, 'thread-2');
    assert.strictEqual(task.automation.sentMessageId, '<r2@x>');
    assert.deepStrictEqual(task.automation.processedMessageIds, ['m1']);
    assert.ok(task.automation.deadlineAt instanceof Date);
    assert.strictEqual(task.automation.replyDraft, undefined);
    assert.match(bot.calls.sent[0].text, /Email enviado a front@hotel\.pe/);

    // Double press: it is not sent twice
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cbs2', data: sendData, message: { chat: { id: 111 }, message_id: 701 } }, { bot, isAuthorizedChat });
    assert.strictEqual(sentEmails.length, 1);

    // Quoted message that is not a notice → handled by the WhatsApp flow
    assert.strictEqual(await telegram.handleTelegramReply({ chat: { id: 111 }, message_id: 602, text: 'hola', reply_to_message: { message_id: 12345 } }, { bot, isAuthorizedChat }), false);

    // Reply button → force-reply message linked to the task
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cb1', data: telegram.buildCallbackData('reply', stored.telegramToken), message: { chat: { id: 111 }, message_id: 500 } }, { bot, isAuthorizedChat });
    assert.strictEqual(bot.calls.sent[0].options.reply_markup.force_reply, true);
    const promptId = tasks.get('t1').automation.telegramMessages.filter(m => m.kind === 'prompt').pop().messageId;

    // "OK" in reply to the forced message → confirms and closes
    bot = fakeBot();
    await telegram.handleTelegramReply({ chat: { id: 111 }, message_id: 603, text: 'ok', reply_to_message: { message_id: promptId } }, { bot, isAuthorizedChat });
    task = tasks.get('t1');
    assert.strictEqual(task.isDone, true);
    assert.strictEqual(task.automation.status, 'executed');
    assert.strictEqual(services.get('s1').confirmed, true);
    assert.strictEqual(services.get('s1').hotelConfirmationNumber, '17298/2026');
    assert.match(bot.calls.sent[0].text, /Hotel confirmado y tarea cerrada/);

    // Accept button on an already closed task: no changes and the buttons are removed
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cb2', data: telegram.buildCallbackData('ok', stored.telegramToken), message: { chat: { id: 111 }, message_id: 500 } }, { bot, isAuthorizedChat });
    assert.deepStrictEqual(bot.calls.answers, ['Sin cambios']);
    assert.strictEqual(bot.calls.edits.length, 1);
    assert.match(bot.calls.sent[0].text, /ya estaba cerrada/);

    // Text on a closed task: no email is sent
    sentEmails.length = 0;
    bot = fakeBot();
    await telegram.handleTelegramReply({ chat: { id: 111 }, message_id: 604, text: 'Gracias', reply_to_message: { message_id: 500 } }, { bot, isAuthorizedChat });
    assert.strictEqual(sentEmails.length, 0);
    assert.match(bot.calls.sent[0].text, /ya está cerrada/);

    // Accept button directly: does not overwrite an existing confirmation number
    resetTask();
    services.get('s1').hotelConfirmationNumber = 'ABC';
    await telegram.notifyHotelReview({ task: tasks.get('t1'), service: services.get('s1'), result, replies: [] });
    bot = fakeBot();
    await telegram.handleCallbackQuery({ id: 'cb3', data: telegram.buildCallbackData('ok', tasks.get('t1').automation.telegramToken), message: { chat: { id: 111 }, message_id: 500 } }, { bot, isAuthorizedChat });
    assert.deepStrictEqual(bot.calls.answers, ['Tarea cerrada']);
    assert.strictEqual(tasks.get('t1').isDone, true);
    assert.strictEqual(services.get('s1').hotelConfirmationNumber, 'ABC');
    assert.strictEqual(tasks.get('t1').automation.replyThreadId, 'thread-1');

    console.log('Telegram de auto tareas de hotel: OK');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
