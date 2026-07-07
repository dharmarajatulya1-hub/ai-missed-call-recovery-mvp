const APP_TIME_ZONE = 'America/New_York';

function getAppTimeZone() {
  return APP_TIME_ZONE;
}

/**
 * Current date (YYYY-MM-DD) in the given IANA timezone.
 * @param {string} tz - IANA timezone (defaults to the app timezone)
 */
function getCurrentDateInTimeZone(tz = APP_TIME_ZONE) {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: tz || APP_TIME_ZONE
  });
}

/**
 * Tomorrow's date (YYYY-MM-DD) in the given IANA timezone.
 * @param {string} tz - IANA timezone (defaults to the app timezone)
 */
function getTomorrowDateInTimeZone(tz = APP_TIME_ZONE) {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return tomorrow.toLocaleDateString('en-CA', {
    timeZone: tz || APP_TIME_ZONE
  });
}

// Backwards-compatible aliases (app-timezone defaults).
function getCurrentDateInAppTimeZone() {
  return getCurrentDateInTimeZone(APP_TIME_ZONE);
}

function getTomorrowDateInAppTimeZone() {
  return getTomorrowDateInTimeZone(APP_TIME_ZONE);
}

module.exports = {
  APP_TIME_ZONE,
  getAppTimeZone,
  getCurrentDateInTimeZone,
  getTomorrowDateInTimeZone,
  getCurrentDateInAppTimeZone,
  getTomorrowDateInAppTimeZone
};
