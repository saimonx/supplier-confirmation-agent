'use strict';

// Language of automatic communications to the end supplier (email to the hotel,
// WhatsApp for transfers and activities). Pure functions, no dependencies.

// Prefixes with "+" that the back-office panel treats as Spanish-speaking (useAutoTaskCompletionDialog.isSpanishSpeakingCountry)
const SPANISH_COUNTRY_CODES = [
    '+34', '+52', '+54', '+56', '+57', '+58', '+51', '+593', '+595', '+598', '+591',
    '+507', '+506', '+503', '+502', '+504', '+505', '+53', '+509', '+1809', '+1829', '+1849'
];

// IANA time zones of Spanish-speaking countries (service location)
const SPANISH_TIME_ZONE_PREFIXES = ['America/Argentina/'];
const SPANISH_TIME_ZONES = [
    'Europe/Madrid', 'Atlantic/Canary', 'Africa/Ceuta', 'Africa/Malabo',
    'America/Buenos_Aires', 'America/Cordoba', 'America/Catamarca', 'America/Jujuy', 'America/Mendoza',
    'America/Mexico_City', 'America/Cancun', 'America/Merida', 'America/Monterrey', 'America/Matamoros',
    'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Ojinaga', 'America/Hermosillo', 'America/Mazatlan',
    'America/Bahia_Banderas', 'America/Tijuana',
    'America/Santiago', 'America/Punta_Arenas', 'Pacific/Easter',
    'America/Lima', 'America/Bogota', 'America/Caracas', 'America/Guayaquil', 'Pacific/Galapagos',
    'America/Asuncion', 'America/Montevideo', 'America/La_Paz',
    'America/Panama', 'America/Costa_Rica', 'America/El_Salvador', 'America/Guatemala',
    'America/Tegucigalpa', 'America/Managua', 'America/Havana', 'America/Santo_Domingo'
];
const SPANISH_EMAIL_TLDS = ['es', 'mx', 'ar', 'cl', 'co', 'pe', 've', 'ec', 'py', 'uy', 'bo', 'pa', 'cr', 'sv', 'gt', 'hn', 'ni', 'cu', 'do'];

function hasSpanishCountryCode(phone) {
    const cleanPhone = String(phone || '').trim();
    return SPANISH_COUNTRY_CODES.some(code => cleanPhone.startsWith(code));
}

// true/false if the time zone is known; null if there is no time zone
function isSpanishTimeZone(timeZone) {
    const zone = String(timeZone || '').trim();
    if (!zone) return null;
    return SPANISH_TIME_ZONES.includes(zone) || SPANISH_TIME_ZONE_PREFIXES.some(prefix => zone.startsWith(prefix));
}

function isSpanishEmailDomain(email) {
    const domain = String(email || '').trim().toLowerCase().split('@')[1];
    if (!domain) return false;
    return SPANISH_EMAIL_TLDS.includes(domain.split('.').pop());
}

/**
 * 1. Service time zone (supplier location) → Spanish if it is a Spanish-speaking country.
 * 2. Phone with a Spanish-speaking international prefix (with "+") → Spanish.
 * 3. Email with a Spanish-speaking country domain → Spanish.
 * No phone → Spanish; otherwise → English.
 */
function detectProviderLanguage({ phone, timeZone, email } = {}) {
    const byTimeZone = isSpanishTimeZone(timeZone);
    if (byTimeZone !== null) return byTimeZone ? 'es' : 'en';
    if (!phone) return 'es';
    if (hasSpanishCountryCode(phone)) return 'es';
    return isSpanishEmailDomain(email) ? 'es' : 'en';
}

module.exports = {
    SPANISH_COUNTRY_CODES,
    hasSpanishCountryCode,
    isSpanishTimeZone,
    isSpanishEmailDomain,
    detectProviderLanguage
};
