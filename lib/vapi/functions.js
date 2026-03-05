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
  description: 'Check available appointment times for a given date. Use this when the customer wants to book or asks about availability.',
  parameters: {
    type: 'object',
    properties: {
      date: {
        type: 'string',
        description: 'Date to check availability (YYYY-MM-DD format). Example: "2024-12-25"',
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
        description: 'Appointment date and time in ISO 8601 format. Example: "2024-12-25T14:30:00Z"',
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
    enableCallback = false,
    customFunctions = []
  } = options;

  const functions = [];

  if (enableBooking) {
    functions.push(checkAvailabilityFunction);
    functions.push(createBookingFunction);
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
    scheduleCallback: scheduleCallbackFunction
  };

  return allFunctions[name] || null;
}

module.exports = {
  checkAvailabilityFunction,
  createBookingFunction,
  scheduleCallbackFunction,
  getFunctions,
  getFunctionByName
};
