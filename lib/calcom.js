/**
 * Cal.com API Integration Library
 * 
 * Handles OAuth2 authentication and booking operations with Cal.com API v2.
 * 
 * Cal.com API Documentation:
 * - API Reference: https://cal.com/docs/api-reference
 * - OAuth2 Flow: https://cal.com/docs/api-reference/oauth
 * - Bookings: https://cal.com/docs/api-reference/bookings
 * 
 * Environment variables required:
 * - CALCOM_CLIENT_ID: OAuth2 client ID from Cal.com
 * - CALCOM_CLIENT_SECRET: OAuth2 client secret
 * - CALCOM_REDIRECT_URI: OAuth callback URL (e.g., https://your-domain.com/api/calcom/oauth)
 */

const axios = require('axios');
const { getBusinessById, getCalcomCredentials, updateCalcomCredentials } = require('./supabase');
const { APP_TIME_ZONE } = require('./time');

const CALCOM_API_BASE = 'https://api.cal.com/v2';
const CALCOM_DEFAULT_API_VERSION = '2024-08-13';
const CALCOM_LEGACY_SLOTS_API_VERSION = '2024-06-06';
const CALCOM_SLOTS_API_VERSION = '2024-09-04';
const CALCOM_CLIENT_ID = process.env.CALCOM_CLIENT_ID;
const CALCOM_CLIENT_SECRET = process.env.CALCOM_CLIENT_SECRET;
const CALCOM_REDIRECT_URI = process.env.CALCOM_REDIRECT_URI;

if (!CALCOM_CLIENT_ID || !CALCOM_CLIENT_SECRET) {
  console.warn('⚠️ Cal.com credentials not configured. Booking features will be disabled.');
}

function buildCalcomHeaders(accessToken, apiVersion = CALCOM_DEFAULT_API_VERSION) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'cal-api-version': apiVersion
  };
}

function getBusinessTimeZone(business, credentials) {
  return business?.timezone || APP_TIME_ZONE;
}

function extractSlotStart(slot) {
  if (typeof slot === 'string') {
    return slot;
  }

  if (!slot || typeof slot !== 'object') {
    return null;
  }

  return slot.start || slot.startTime || slot.time || null;
}

function normalizeSlotsResponse(payload) {
  const root = payload?.data ?? payload;
  const nestedSlots = root?.slots;

  if (Array.isArray(nestedSlots)) {
    return nestedSlots.map(extractSlotStart).filter(Boolean);
  }

  if (nestedSlots && typeof nestedSlots === 'object') {
    return Object.values(nestedSlots)
      .flatMap(daySlots => Array.isArray(daySlots) ? daySlots : [])
      .map(extractSlotStart)
      .filter(Boolean);
  }

  if (Array.isArray(root)) {
    return root.map(extractSlotStart).filter(Boolean);
  }

  if (!root || typeof root !== 'object') {
    return [];
  }

  return Object.values(root)
    .flatMap(daySlots => Array.isArray(daySlots) ? daySlots : [])
    .map(extractSlotStart)
    .filter(Boolean);
}

function unwrapCalcomData(payload) {
  return payload?.data ?? payload;
}

function getHourInTimeZone(dateTime, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone
  }).formatToParts(new Date(dateTime));

  const hour = parts.find(part => part.type === 'hour');
  return hour ? Number(hour.value) : NaN;
}

function normalizePhoneNumber(phone) {
  if (!phone) {
    return null;
  }

  const trimmed = String(phone).trim();

  if (trimmed.startsWith('+')) {
    const digits = trimmed.replace(/[^\d+]/g, '');
    return /^\+\d{10,15}$/.test(digits) ? digits : null;
  }

  const digitsOnly = trimmed.replace(/\D/g, '');

  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }

  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    return `+${digitsOnly}`;
  }

  return null;
}

function getTimePartsInTimeZone(dateTime, timeZone = APP_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(dateTime));

  const lookup = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );

  return {
    date: `${lookup.year}-${lookup.month}-${lookup.day}`,
    time: `${lookup.hour}:${lookup.minute}`
  };
}

function getRequestedWallClockParts(dateTime) {
  const match = String(dateTime || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);

  if (!match) {
    return null;
  }

  return {
    date: match[1],
    time: `${match[2]}:${match[3]}`
  };
}

async function resolveBookingStartTime(businessId, requestedStart) {
  const requestedWallClock = getRequestedWallClockParts(requestedStart);
  const requestedInstant = new Date(requestedStart);

  if (!requestedWallClock || Number.isNaN(requestedInstant.getTime())) {
    throw new Error('Invalid booking start time');
  }

  const availableSlots = await checkAvailability(businessId, requestedWallClock.date, 'any');

  const wallClockMatch = availableSlots.find(slot => {
    const slotParts = getTimePartsInTimeZone(slot, APP_TIME_ZONE);
    return slotParts.date === requestedWallClock.date && slotParts.time === requestedWallClock.time;
  });

  if (wallClockMatch) {
    console.warn('⚠️ Adjusted booking start to exact available slot in New York timezone:', {
      requestedStart,
      resolvedStart: wallClockMatch
    });
    return wallClockMatch;
  }

  const exactInstantMatch = availableSlots.find(slot =>
    new Date(slot).getTime() === requestedInstant.getTime()
  );

  if (exactInstantMatch) {
    return exactInstantMatch;
  }

  throw new Error(`Requested slot ${requestedWallClock.date} ${requestedWallClock.time} is not currently available`);
}

/**
 * Generate Cal.com OAuth2 authorization URL
 * @param {string} businessId - Business UUID to store in state
 * @returns {string} Authorization URL
 */
function getAuthorizationUrl(businessId) {
  if (!CALCOM_CLIENT_ID || !CALCOM_REDIRECT_URI) {
    throw new Error('Cal.com OAuth not configured');
  }

  const state = Buffer.from(JSON.stringify({ businessId })).toString('base64');
  
  // Cal.com OAuth authorization endpoint
  const params = new URLSearchParams({
    client_id: CALCOM_CLIENT_ID,
    redirect_uri: CALCOM_REDIRECT_URI,
    response_type: 'code',
    state: state
  });

  return `https://app.cal.com/auth/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 * @param {string} code - Authorization code from OAuth callback
 * @returns {Promise<Object>} Token response
 */
async function exchangeCodeForToken(code) {
  if (!CALCOM_CLIENT_ID || !CALCOM_CLIENT_SECRET || !CALCOM_REDIRECT_URI) {
    throw new Error('Cal.com OAuth not configured');
  }

  try {
    // Cal.com OAuth token endpoint
    const tokenUrl = 'https://api.cal.com/v2/auth/oauth2/token';
    
    console.log('🔐 Exchanging code for token at:', tokenUrl);
    
    const response = await axios.post(tokenUrl, {
      client_id: CALCOM_CLIENT_ID,
      client_secret: CALCOM_CLIENT_SECRET,
      redirect_uri: CALCOM_REDIRECT_URI,
      grant_type: 'authorization_code',
      code: code
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log('✅ Token exchange successful');
    return response.data;
    
  } catch (error) {
    console.error('❌ Token exchange failed:', error.response?.status, error.response?.data);
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 * @param {string} refreshToken - Refresh token
 * @returns {Promise<Object>} New token response
 */
async function refreshAccessToken(refreshToken) {
  if (!CALCOM_CLIENT_ID || !CALCOM_CLIENT_SECRET) {
    throw new Error('Cal.com OAuth not configured');
  }

  try {
    const response = await axios.post('https://api.cal.com/v2/auth/oauth2/token', {
      client_id: CALCOM_CLIENT_ID,
      client_secret: CALCOM_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 6000
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    return {
      access_token,
      refresh_token,
      expires_at: expiresAt
    };
  } catch (error) {
    console.error('❌ Error refreshing token:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Get valid access token for a business (auto-refresh if expired)
 * @param {string} businessId - Business UUID
 * @returns {Promise<string>} Valid access token
 */
async function getValidAccessToken(businessId) {
  const credentials = await getCalcomCredentials(businessId);
  
  console.log('🔍 Validating token for business:', businessId);
  console.log('   Credentials:', {
    hasAccessToken: !!credentials?.access_token,
    hasRefreshToken: !!credentials?.refresh_token,
    expiresAt: credentials?.token_expires_at
  });
  
  if (!credentials || !credentials.access_token) {
    throw new Error('Business not connected to Cal.com');
  }

  // Check if token is expired or will expire in the next 5 minutes
  const expiresAt = new Date(credentials.token_expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt < fiveMinutesFromNow) {
    console.log('🔄 Refreshing expired Cal.com token');
    
    const newTokens = await refreshAccessToken(credentials.refresh_token);
    await updateCalcomCredentials(businessId, newTokens);
    
    return newTokens.access_token;
  }

  console.log('✅ Token is valid');
  return credentials.access_token;
}

/**
 * Make authenticated request to Cal.com API
 * @param {string} businessId - Business UUID
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint (without base URL)
 * @param {Object} data - Request body
 * @returns {Promise<Object>} API response
 */
async function calcomApiRequest(businessId, method, endpoint, data = null, options = {}) {
  const {
    apiVersion = CALCOM_DEFAULT_API_VERSION,
    params = null
  } = options;
  const accessToken = await getValidAccessToken(businessId);
  
  const url = `${CALCOM_API_BASE}${endpoint}`;
  console.log('📡 Cal.com API request:', { method, url });
  
  const config = {
    method,
    url,
    headers: buildCalcomHeaders(accessToken, apiVersion),
    // Cap Cal.com calls so a slow API cannot hang a tool call to Vercel's 30s
    // ceiling (dead air on the call). Callers fall back to "take a message".
    timeout: 6000
  };

  if (data) {
    config.data = data;
  }

  if (params) {
    config.params = params;
  }

  try {
    const response = await axios(config);
    console.log('✅ Cal.com API success:', endpoint);
    return response.data;
  } catch (error) {
    console.error('❌ Cal.com API error:', {
      endpoint,
      url,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
}

/**
 * Get user's event types (appointment types)
 * @param {string} businessId - Business UUID
 * @returns {Promise<Array>} List of event types
 */
async function getEventTypes(businessId) {
  console.log('📋 Fetching event types...');
  const response = await calcomApiRequest(businessId, 'GET', '/event-types');
  console.log('📋 Event types response:', JSON.stringify(response).substring(0, 500));
  
  // Handle different response structures
  if (Array.isArray(response)) {
    return response;
  }
  if (response.data && Array.isArray(response.data.eventTypes)) {
    return response.data.eventTypes;
  }
  if (response.data && Array.isArray(response.data)) {
    return response.data;
  }
  if (response.eventTypes && Array.isArray(response.eventTypes)) {
    return response.eventTypes;
  }
  
  console.warn('⚠️ Unexpected event types response structure:', response);
  return [];
}

/**
 * Check availability for a specific date
 * @param {string} businessId - Business UUID
 * @param {string} date - Date to check (YYYY-MM-DD)
 * @param {string} timePreference - 'morning', 'afternoon', 'evening', or 'any'
 * @returns {Promise<Array>} Available time slots (ISO 8601 strings)
 */
async function checkAvailability(businessId, date, timePreference = 'any') {
  console.log('📅 Checking availability:', { businessId, date, timePreference });
  
  const [credentials, business] = await Promise.all([
    getCalcomCredentials(businessId),
    getBusinessById(businessId)
  ]);

  if (!credentials || !credentials.access_token) {
    throw new Error('Business not connected to Cal.com');
  }
  
  // Get event_type_id from config (stored as JSONB)
  const eventTypeId = credentials?.config?.event_type_id || credentials?.calcom_event_type_id;
  const timeZone = getBusinessTimeZone(business, credentials);
  
  if (!eventTypeId) {
    console.error('❌ No event type ID found for availability check');
    throw new Error('No default event type configured for business');
  }
  
  console.log('📅 Using event type ID:', eventTypeId, 'timezone:', timeZone);

  try {
    const startTime = `${date}T00:00:00.000Z`;
    const endTime = `${date}T23:59:59.999Z`;

    let response = null;
    let slots = [];

    try {
      response = await calcomApiRequest(
        businessId,
        'GET',
        '/slots/available',
        null,
        {
          apiVersion: CALCOM_LEGACY_SLOTS_API_VERSION,
          params: {
            eventTypeId: String(parseInt(eventTypeId, 10)),
            startTime,
            endTime,
            timeZone
          }
        }
      );

      console.log('📅 Legacy slots API response:', JSON.stringify(response).substring(0, 500));
      slots = normalizeSlotsResponse(response);
    } catch (legacyError) {
      if (legacyError.response?.status !== 404) {
        throw legacyError;
      }

      console.log('⚠️ Legacy slots endpoint not available, falling back to /slots');
    }

    if (!slots.length) {
      response = await calcomApiRequest(
        businessId,
        'GET',
        '/slots',
        null,
        {
          apiVersion: CALCOM_SLOTS_API_VERSION,
          params: {
            eventTypeId: String(parseInt(eventTypeId, 10)),
            start: date,
            end: date,
            timeZone,
            format: 'time'
          }
        }
      );

      console.log('📅 Fallback slots API response:', JSON.stringify(response).substring(0, 500));
      slots = normalizeSlotsResponse(response);
    }

    slots = slots.sort();
    
    console.log('📅 Found', slots.length, 'available slots');

    // Filter by time preference
    if (timePreference !== 'any' && slots.length > 0) {
      slots = filterSlotsByTimePreference(slots, timePreference, timeZone);
    }

    return slots;
    
  } catch (error) {
    console.error('❌ Slots API error:', error.response?.status, error.response?.data);
    throw error;
  }
}

/**
 * Filter time slots by time of day preference
 * @param {Array} slots - Array of ISO 8601 time strings
 * @param {string} preference - 'morning', 'afternoon', or 'evening'
 * @param {string} timeZone - IANA timezone used to interpret the slot hour
 * @returns {Array} Filtered slots
 */
function filterSlotsByTimePreference(slots, preference, timeZone = APP_TIME_ZONE) {
  return slots.filter(slot => {
    const hour = getHourInTimeZone(slot, timeZone);
    
    switch (preference) {
      case 'morning':
        return hour >= 6 && hour < 12;
      case 'afternoon':
        return hour >= 12 && hour < 17;
      case 'evening':
        return hour >= 17 && hour < 21;
      default:
        return true;
    }
  });
}

/**
 * Create a booking/appointment
 * @param {string} businessId - Business UUID
 * @param {Object} bookingData - Booking details
 * @param {string} bookingData.name - Customer name
 * @param {string} bookingData.email - Customer email
 * @param {string} bookingData.phone - Customer phone
 * @param {string} bookingData.start - Start time (ISO 8601)
 * @param {string} bookingData.notes - Optional notes
 * @returns {Promise<Object>} Created booking
 */
async function createCalcomBooking(businessId, bookingData) {
  const [credentials, business] = await Promise.all([
    getCalcomCredentials(businessId),
    getBusinessById(businessId)
  ]);

  if (!credentials || !credentials.access_token) {
    throw new Error('Business not connected to Cal.com');
  }
  
  // Get event_type_id from config (stored as JSONB)
  const eventTypeId = credentials?.config?.event_type_id || credentials?.calcom_event_type_id;
  const timeZone = getBusinessTimeZone(business, credentials);
  
  if (!eventTypeId) {
    console.error('❌ No event type ID found for business:', businessId);
    console.error('   Config:', credentials.config);
    throw new Error('No default event type configured for business');
  }
  
  console.log('📅 Creating booking with event type ID:', eventTypeId);

  const normalizedPhone = normalizePhoneNumber(bookingData.phone);
  const resolvedStart = await resolveBookingStartTime(businessId, bookingData.start);
  const normalizedStart = new Date(resolvedStart).toISOString();

  if (bookingData.phone && !normalizedPhone) {
    console.warn('⚠️ Dropping invalid attendee phone for Cal.com booking:', bookingData.phone);
  }

  const payload = {
    eventTypeId: parseInt(eventTypeId, 10),
    start: normalizedStart,
    attendee: {
      name: bookingData.name,
      email: bookingData.email,
      timeZone,
      language: 'en',
      ...(normalizedPhone ? { phoneNumber: normalizedPhone } : {})
    },
    guests: [],
    metadata: {
      source: 'vapi-ai-assistant',
      phone: bookingData.phone,
      notes: bookingData.notes
    }
  };

  const response = await calcomApiRequest(
    businessId,
    'POST',
    '/bookings',
    payload,
    { apiVersion: CALCOM_DEFAULT_API_VERSION }
  );
  const booking = unwrapCalcomData(response);

  console.log('✅ Cal.com booking created:', booking);
  
  return booking;
}

/**
 * Get booking details
 * @param {string} businessId - Business UUID
 * @param {string} bookingUid - Cal.com booking UID
 * @returns {Promise<Object>} Booking details
 */
async function getBooking(businessId, bookingUid) {
  const response = await calcomApiRequest(businessId, 'GET', `/bookings/${bookingUid}`);
  return unwrapCalcomData(response);
}

/**
 * Cancel a booking
 * @param {string} businessId - Business UUID
 * @param {string} bookingUid - Cal.com booking UID
 * @param {string} reason - Cancellation reason
 * @returns {Promise<Object>} Cancellation response
 */
async function cancelBooking(businessId, bookingUid, reason = 'Cancelled by customer') {
  const response = await calcomApiRequest(
    businessId,
    'DELETE',
    `/bookings/${bookingUid}`,
    { reason }
  );
  
  console.log('✅ Cal.com booking cancelled:', bookingUid);
  
  return unwrapCalcomData(response);
}

/**
 * Reschedule a booking
 * @param {string} businessId - Business UUID
 * @param {string} bookingUid - Cal.com booking UID
 * @param {string} newStart - New start time (ISO 8601)
 * @returns {Promise<Object>} Updated booking
 */
async function rescheduleBooking(businessId, bookingUid, newStart) {
  const response = await calcomApiRequest(
    businessId,
    'PATCH',
    `/bookings/${bookingUid}`,
    { start: newStart }
  );
  
  console.log('✅ Cal.com booking rescheduled:', bookingUid);
  
  return unwrapCalcomData(response);
}

module.exports = {
  getAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidAccessToken,
  getEventTypes,
  checkAvailability,
  createCalcomBooking,
  getBooking,
  cancelBooking,
  rescheduleBooking
};
