/**
 * Debug Endpoint: Test Cal.com Connection
 * 
 * Tests if Cal.com OAuth and API calls are working
 * 
 * Usage: GET /api/debug/test-calcom?phone=+19846007391
 */

const { getCalcomCredentials } = require('../../lib/supabase');
const { getEventTypes, checkAvailability } = require('../../lib/calcom');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic auth check
  if (process.env.NODE_ENV === 'production') {
    const secret = req.query.secret || req.headers['x-debug-secret'];
    if (secret !== process.env.DEBUG_SECRET) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const phone = req.query.phone || '+19846007391';
  const testDate = req.query.date || new Date().toISOString().split('T')[0];

  console.log('🔍 Testing Cal.com connection for:', phone);

  try {
    // Step 1: Get business by phone
    const { getBusinessByPhone } = require('../../lib/supabase');
    const business = await getBusinessByPhone(phone);
    
    if (!business) {
      return res.status(404).json({
        error: 'Business not found',
        phone
      });
    }

    console.log('✅ Business found:', business.name);

    // Step 2: Check Cal.com credentials
    console.log('🔍 Checking Cal.com credentials...');
    const credentials = await getCalcomCredentials(business.id);
    
    if (!credentials) {
      return res.status(400).json({
        error: 'Cal.com not connected',
        message: 'No credentials found for this business',
        business: business.name
      });
    }

    const hasAccessToken = !!credentials.access_token;
    const hasRefreshToken = !!credentials.refresh_token;
    const eventTypeId = credentials.config?.event_type_id || credentials.calcom_event_type_id;

    console.log('✅ Credentials found:', {
      hasAccessToken,
      hasRefreshToken,
      eventTypeId
    });

    // Step 3: Test fetching event types (verifies token works)
    console.log('🔍 Testing API call - fetching event types...');
    let eventTypes = [];
    let eventTypesError = null;
    
    try {
      eventTypes = await getEventTypes(business.id);
      console.log('✅ Event types fetched:', eventTypes.length);
    } catch (err) {
      console.error('❌ Event types failed:', err.message);
      eventTypesError = err.message;
    }

    // Step 4: Test fetching availability
    console.log('🔍 Testing availability check for:', testDate);
    let availability = [];
    let availabilityError = null;
    
    try {
      availability = await checkAvailability(business.id, testDate, 'any');
      console.log('✅ Availability found:', availability.length, 'slots');
    } catch (err) {
      console.error('❌ Availability check failed:', err.message);
      availabilityError = err.message;
    }

    // Return results
    return res.status(200).json({
      success: true,
      business: {
        id: business.id,
        name: business.name,
        calcom_enabled: business.calcom_enabled
      },
      credentials: {
        hasAccessToken,
        hasRefreshToken,
        eventTypeId,
        config: credentials.config
      },
      tests: {
        eventTypes: {
          success: eventTypesError === null,
          count: eventTypes.length,
          error: eventTypesError,
          data: eventTypes.slice(0, 2) // First 2 only
        },
        availability: {
          success: availabilityError === null,
          date: testDate,
          slotsFound: availability.length,
          error: availabilityError,
          slots: availability.slice(0, 3) // First 3 slots
        }
      },
      status: eventTypesError || availabilityError ? 'PARTIAL_FAILURE' : 'OK'
    });

  } catch (error) {
    console.error('❌ Test failed:', error);
    return res.status(500).json({
      error: 'Test failed',
      message: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
};
