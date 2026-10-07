'use strict';

// Customer email senders (MJML templates over AWS SES) used by the non-hotel automations.
// Not part of this extract.
module.exports = {
    sendEmail1MonthBeforeTravel: async () => { throw new Error('emails_adapter_not_configured'); },
    sendEmail10DaysBeforeTravelWithAssuranceApp: async () => { throw new Error('emails_adapter_not_configured'); }
};
