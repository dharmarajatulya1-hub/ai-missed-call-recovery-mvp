/**
 * VAPI Function Definitions
 * 
 * OpenAI-style function/tool definitions for VAPI assistants.
 * These enable the AI to perform actions like booking appointments.
 */

/**
 * Check availability function - finds open appointment slots
 */
const checkAvailabilityFunction = {
  name: 'checkAvailability',
  description: 'Check available appointment times for a given date. Use this when the customer wants to book or asks about availability. Call this at most twice per booking request. If two calls do not find a workable time, stop and offer to take a message instead of checking more dates.',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'Date to check availability in YYYY-MM-DD format. Use the actual current year and convert relative dates like today or tomorrow into an explicit future date. Never use a past date. Example: "2026-03-09"',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$'
      },
      timePreference: {
        type: 'string',
        enum: ['morning', 'afternoon', 'evening', 'any'],
        description: 'Preferred time of day. Use "any" if customer has no preference.'
      }
    },
    required: ['date']
  }
};

/**
 * Create booking function - confirms an appointment
 */
const createBookingFunction = {
  name: 'createBooking',
  description: 'Create an appointment booking after the customer confirms a time. Always confirm all details before calling this function.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Customer full name. Example: "John Doe"'
      },
      email: {
        type: 'string',
        description: 'Customer email address for confirmation. Example: "john@example.com"'
      },
      phone: {
        type: 'string',
        description: 'Customer phone number (optional, will use caller ID if not provided)'
      },
      dateTime: {
        type: 'string',
        description: 'Appointment date and time in ISO 8601 format using the exact slot returned by checkAvailability. Do not reconstruct it manually and do not change the timezone offset. Never use a past date. Example: "2026-03-09T14:00:00-04:00"',
        format: 'date-time'
      },
      notes: {
        type: 'string',
        description: 'Additional notes or reason for appointment. Example: "Annual cleaning, prefers morning appointments"'
      }
    },
    required: ['name', 'email', 'dateTime']
  }
};

/**
 * Capture booking request function - capture-and-confirm mode (default).
 * Records a structured request for the team to confirm later; no live lookup.
 */
const captureBookingRequestFunction = {
  name: 'captureBookingRequest',
  description: 'Record a booking request with the caller\'s desired service, preferred times, and contact info for the team to confirm later. Use this instead of checking live availability. Call it once, after you have the service, at least one preferred time window, the caller\'s name, and a phone number.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Customer full name. Example: "John Doe"'
      },
      phone: {
        type: 'string',
        description: 'Best callback phone number. If the caller does not give one, use their caller ID.'
      },
      email: {
        type: 'string',
        description: 'Customer email address (optional).'
      },
      service: {
        type: 'string',
        description: 'The service the caller wants. Use "callback" if they only want a return call. Example: "oil change"'
      },
      preferredTimes: {
        type: 'array',
        items: { type: 'string' },
        description: 'One to three natural-language day/time windows the caller offered. Example: ["Tuesday morning", "Thursday after 3pm"]'
      },
      notes: {
        type: 'string',
        description: 'Any additional details or context (optional).'
      }
    },
    required: ['name', 'phone', 'service', 'preferredTimes']
  }
};

/**
 * Schedule callback function - for businesses without Cal.com
 */
const scheduleCallbackFunction = {
  name: 'scheduleCallback',
  description: 'Record a request for a callback when the customer prefers to be contacted later or when booking is not available.',
  parameters: {
    type: 'object',
    properties: {
      preferredTime: {
        type: 'string',
        description: 'When the customer prefers to be called back. Example: "tomorrow morning", "after 3pm today"'
      },
      reason: {
        type: 'string',
        description: 'Reason for the callback request'
      }
    },
    required: ['reason']
  }
};

/**
 * Get functions based on feature flags
 * @param {Object} options - Feature flags
 * @returns {Array} Array of function definitions
 */
function getFunctions(options = {}) {
  const {
    enableBooking = false,
    enableCapture = false,
    enableCallback = false,
    customFunctions = []
  } = options;

  const functions = [];

  if (enableBooking) {
    // Live mode: real Cal.com availability + booking.
    functions.push(checkAvailabilityFunction);
    functions.push(createBookingFunction);
  } else if (enableCapture) {
    // Capture-and-confirm mode: structured request, no live lookup. This
    // replaces the live tools (never both at once).
    functions.push(captureBookingRequestFunction);
  }

  if (enableCallback) {
    functions.push(scheduleCallbackFunction);
  }

  // Add any custom functions
  if (customFunctions.length > 0) {
    functions.push(...customFunctions);
  }

  return functions;
}

/**
 * Get single function by name
 * @param {string} name - Function name
 * @returns {Object|null} Function definition
 */
function getFunctionByName(name) {
  const allFunctions = {
    checkAvailability: checkAvailabilityFunction,
    createBooking: createBookingFunction,
    captureBookingRequest: captureBookingRequestFunction,
    scheduleCallback: scheduleCallbackFunction
  };

  return allFunctions[name] || null;
}

module.exports = {
  checkAvailabilityFunction,
  createBookingFunction,
  captureBookingRequestFunction,
  scheduleCallbackFunction,
  getFunctions,
  getFunctionByName
};
