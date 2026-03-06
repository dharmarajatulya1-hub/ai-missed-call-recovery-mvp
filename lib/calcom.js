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
const { getCalcomCredentials, updateCalcomCredentials } = require('./supabase');

const CALCOM_API_BASE = 'https://api.cal.com/v2';
const CALCOM_CLIENT_ID = process.env.CALCOM_CLIENT_ID;
const CALCOM_CLIENT_SECRET = process.env.CALCOM_CLIENT_SECRET;
const CALCOM_REDIRECT_URI = process.env.CALCOM_REDIRECT_URI;

if (!CALCOM_CLIENT_ID || !CALCOM_CLIENT_SECRET) {
  console.warn('⚠️ Cal.com credentials not configured. Booking features will be disabled.');
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
  
  // Cal.com OAuth authorization endpoint (from official docs)
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

  // Cal.com OAuth token endpoint (from official docs)
  const tokenUrl = 'https://api.cal.com/v2/auth/oauth2/token';
  
  try {
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
      }
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
  
  if (!credentials || !credentials.calcom_access_token) {
    throw new Error('Business not connected to Cal.com');
  }

  // Check if token is expired or will expire in the next 5 minutes
  const expiresAt = new Date(credentials.calcom_token_expires_at);
  const now = new Date();
  const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

  if (expiresAt < fiveMinutesFromNow) {
    console.log('🔄 Refreshing expired Cal.com token');
    
    const newTokens = await refreshAccessToken(credentials.calcom_refresh_token);
    await updateCalcomCredentials(businessId, newTokens);
    
    return newTokens.access_token;
  }

  return credentials.calcom_access_token;
}

/**
 * Make authenticated request to Cal.com API
 * @param {string} businessId - Business UUID
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint (without base URL)
 * @param {Object} data - Request body
 * @returns {Promise<Object>} API response
 */
async function calcomApiRequest(businessId, method, endpoint, data = null) {
  const accessToken = await getValidAccessToken(businessId);
  
  const config = {
    method,
    url: `${CALCOM_API_BASE}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'cal-api-version': '2024-08-13' // Use latest stable API version
    }
  };

  if (data) {
    config.data = data;
  }

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('❌ Cal.com API error:', {
      endpoint,
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
  const response = await calcomApiRequest(businessId, 'GET', '/event-types');
  return response.data || [];
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
  
  const credentials = await getCalcomCredentials(businessId);
  
  // Get event_type_id from config (stored as JSONB)
  const eventTypeId = credentials.config?.event_type_id || credentials.calcom_event_type_id;
  
  if (!eventTypeId) {
    console.error('❌ No event type ID found for availability check');
    throw new Error('No default event type configured for business');
  }

  console.log('📅 Using event type ID:', eventTypeId);

  // Cal.com requires start and end time for availability check
  const startTime = `${date}T00:00:00Z`;
  const endTime = `${date}T23:59:59Z`;

  console.log('📅 Fetching slots from:', startTime, 'to', endTime);

  const response = await calcomApiRequest(
    businessId,
    'GET',
    `/slots/available?eventTypeId=${parseInt(eventTypeId, 10)}&startTime=${startTime}&endTime=${endTime}`
  );

  const slots = response.slots || [];
  console.log('📅 Found', slots.length, 'available slots');

  // Filter by time preference
  if (timePreference !== 'any' && slots.length > 0) {
    return filterSlotsByTimePreference(slots, timePreference);
  }

  return slots;
}

/**
 * Filter time slots by time of day preference
 * @param {Array} slots - Array of ISO 8601 time strings
 * @param {string} preference - 'morning', 'afternoon', or 'evening'
 * @returns {Array} Filtered slots
 */
function filterSlotsByTimePreference(slots, preference) {
  return slots.filter(slot => {
    const hour = new Date(slot).getHours();
    
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
  const credentials = await getCalcomCredentials(businessId);
  
  // Get event_type_id from config (stored as JSONB)
  const eventTypeId = credentials.config?.event_type_id || credentials.calcom_event_type_id;
  
  if (!eventTypeId) {
    console.error('❌ No event type ID found for business:', businessId);
    console.error('   Config:', credentials.config);
    throw new Error('No default event type configured for business');
  }
  
  console.log('📅 Creating booking with event type ID:', eventTypeId);

  const payload = {
    eventTypeId: parseInt(eventTypeId, 10), // Ensure it's a number
    start: bookingData.start,
    attendee: {
      name: bookingData.name,
      email: bookingData.email,
      timeZone: credentials.timezone || 'America/New_York',
      language: 'en'
    },
    guests: [], // Can add additional guests if needed
    metadata: {
      source: 'vapi-ai-assistant',
      phone: bookingData.phone,
      notes: bookingData.notes
    }
  };

  const response = await calcomApiRequest(businessId, 'POST', '/bookings', payload);
  
  console.log('✅ Cal.com booking created:', response.data);
  
  return response.data;
}

/**
 * Get booking details
 * @param {string} businessId - Business UUID
 * @param {string} bookingUid - Cal.com booking UID
 * @returns {Promise<Object>} Booking details
 */
async function getBooking(businessId, bookingUid) {
  const response = await calcomApiRequest(businessId, 'GET', `/bookings/${bookingUid}`);
  return response.data;
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
  
  return response.data;
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
  
  return response.data;
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
