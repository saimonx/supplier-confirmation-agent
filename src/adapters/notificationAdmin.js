'use strict';

// Telegram bot used to reach the human operator. Not part of this extract;
// tests inject a fake that records the messages sent.
module.exports = {
    sendCommunicationsTelegramMessage: async () => { throw new Error('telegram_adapter_not_configured'); },
    sendNotificationAdmin: async () => { throw new Error('telegram_adapter_not_configured'); }
};
