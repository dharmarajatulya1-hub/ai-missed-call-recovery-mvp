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
 *   - voice: Voice preset - 'rachel', 'adam', 'bella' (default: rachel)
 */

const { getBusinessByPhone, getCalcomCredentials } = require('../../lib/supabase');
const { 
  buildAssistantConfig, 
  buildBasicConfig, 
  buildBookingConfig,
  validateConfig 
} = require('../../lib/vapi');
const { buildSystemPrompt } = require('../../lib/prompts');

module.exports = async (req, res) => {
  // Basic auth check - require secret in production
  if (process.env.NODE_ENV === 'production') {
    const secret = req.query.secret || req.headers['x-debug-secret'];
    if (secret !== process.env.DEBUG_SECRET) {
      return res.status(403).json({ error: 'Forbidden - invalid or missing debug secret' });
    }
  }

  const { 
    phone = '+15551234567', 
    type,
    enhanced = 'false',
    voice = 'rachel'
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
    const hasCalcom = !!(business.calcom_enabled && calcomIntegration?.access_token);

    // Determine config type
    const configType = type || (hasCalcom ? 'booking' : 'basic');

    // Build configs
    let config;
    if (configType === 'booking' && hasCalcom) {
      config = buildBookingConfig(business, calcomIntegration);
    } else if (configType === 'basic') {
      config = buildBasicConfig(business);
    } else {
      config = buildAssistantConfig(business, {
        enableBooking: configType === 'booking',
        voicePreset: voice
      });
    }

    // Validate
    const validation = validateConfig(config);

    // Build enhanced version if requested
    let enhancedPrompt = null;
    if (enhanced === 'true') {
      enhancedPrompt = buildSystemPrompt(business, {
        enableBooking: hasCalcom,
        personality: 'the AI receptionist',
        tone: 'Warm, professional, and helpful'
      });
    }

    // Format response
    const response = {
      meta: {
        phone,
        configType,
        hasCalcom,
        validation
      },
      business: {
        id: business.id,
        name: business.name,
        timezone: business.timezone,
        calcom_enabled: business.calcom_enabled,
        business_hours: business.business_hours
      },
      generated: {
        firstMessage: config.firstMessage,
        endCallMessage: config.endCallMessage,
        systemPrompt: config.model.messages[0].content,
        voice: config.voice,
        hasFunctions: !!config.functions,
        functionNames: config.functions?.map(f => f.name) || []
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
