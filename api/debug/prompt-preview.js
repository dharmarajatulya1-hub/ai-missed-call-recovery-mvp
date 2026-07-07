/**
 * Debug Endpoint: Preview Generated Prompts
 * 
 * Use this to test prompt generation without making actual calls.
 * 
 * Usage:
 *   GET /api/debug/prompt-preview?phone=+15551234567&enhanced=true
 * 
 * Query Parameters:
 *   - phone: Business phone number (required)
 *   - type: Config type - 'basic', 'booking' (default: auto-detect)
 *   - enhanced: Include business hours in prompt (default: false)
 *   - voice: Voice preset - 'sarah', 'tara', 'rachel', 'adam', 'bella' (default: sarah)
 */

const { getBusinessByPhone, getCalcomCredentials } = require('../../lib/supabase');
const { 
  buildAssistantConfig, 
  buildBasicConfig, 
  buildBookingConfig,
  validateConfig 
} = require('../../lib/vapi');
const { buildSystemPrompt } = require('../../lib/prompts');
const { APP_TIME_ZONE } = require('../../lib/time');

module.exports = async (req, res) => {
  // Fail closed: this endpoint leaks full system prompts (hours, ai_instructions,
  // FAQ) per phone number. Require DEBUG_SECRET to be both set and matched — an
  // unset env var must never pass (undefined !== undefined would).
  const secret = req.query.secret || req.headers['x-debug-secret'];
  if (!process.env.DEBUG_SECRET || secret !== process.env.DEBUG_SECRET) {
    return res.status(403).json({ error: 'Forbidden - invalid or missing debug secret' });
  }

  const { 
    phone = '+15551234567', 
    type,
    enhanced = 'false',
    voice = 'sarah'
  } = req.query;

  try {
    // Fetch business
    const business = await getBusinessByPhone(phone);
    
    if (!business) {
      return res.status(404).json({
        error: 'Business not found',
        phone,
        suggestion: 'Check business_phone_numbers table or use a different phone number'
      });
    }

    // Check Cal.com
    const calcomIntegration = await getCalcomCredentials(business.id);
    const hasCalcomToken = !!(business.calcom_enabled && calcomIntegration?.access_token);

    // Resolve booking mode (mirrors the webhook). `type` query param overrides
    // for manual testing: 'booking'|'live' → live, 'basic'|'capture' → capture,
    // 'callback' → callback, 'none' → none.
    let bookingMode = business.booking_mode || 'capture';
    if (type === 'booking' || type === 'live') bookingMode = 'live';
    else if (type === 'basic' || type === 'capture') bookingMode = 'capture';
    else if (type === 'callback') bookingMode = 'callback';
    else if (type === 'none') bookingMode = 'none';
    if (business.appointment_handling_enabled === false) bookingMode = 'none';
    if (bookingMode === 'live' && !hasCalcomToken) bookingMode = 'capture';

    const voiceOptions = {
      voicePreset: voice,
      appointmentHandlingEnabled: business.appointment_handling_enabled
    };
    let config;
    if (bookingMode === 'live') {
      config = buildBookingConfig(business, calcomIntegration, voiceOptions);
    } else if (bookingMode === 'capture') {
      config = buildAssistantConfig(business, {
        enableBooking: false,
        enableCapture: true,
        ...voiceOptions
      });
    } else if (bookingMode === 'callback') {
      config = buildBasicConfig(business, {
        ...voiceOptions,
        enableCallback: true
      });
    } else {
      config = buildBasicConfig(business, voiceOptions);
    }

    // Validate
    const validation = validateConfig(config);

    // Build enhanced version if requested
    let enhancedPrompt = null;
    if (enhanced === 'true') {
      enhancedPrompt = buildSystemPrompt(business, {
        enableBooking: bookingMode === 'live',
        enableCapture: bookingMode === 'capture',
        enableCallback: bookingMode === 'callback',
        appointmentHandlingEnabled: business.appointment_handling_enabled,
        personality: 'the AI receptionist',
        tone: 'Warm, professional, and helpful'
      });
    }

    // Format response
    const response = {
      meta: {
        phone,
        bookingMode,
        hasCalcomToken,
        validation
      },
      business: {
        id: business.id,
        name: business.name,
        timezone: business.timezone || APP_TIME_ZONE,
        calcom_enabled: business.calcom_enabled,
        booking_mode: business.booking_mode,
        appointment_handling_enabled: business.appointment_handling_enabled,
        business_hours: business.business_hours
      },
      generated: {
        firstMessage: config.firstMessage,
        endCallMessage: config.endCallMessage,
        systemPrompt: config.model.messages[0].content,
        voice: config.voice,
        hasFunctions: !!config.model.functions,
        functionNames: config.model.functions?.map(f => f.name) || []
      },
      ...(enhancedPrompt && {
        enhanced: {
          systemPrompt: enhancedPrompt,
          note: 'This version includes more business context like hours and services'
        }
      })
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error('Debug endpoint error:', error);
    return res.status(500).json({
      error: 'Internal error',
      message: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
};
