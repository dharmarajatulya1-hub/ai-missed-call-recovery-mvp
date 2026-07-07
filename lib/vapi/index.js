/**
 * VAPI Configuration Generators
 * 
 * Creates complete assistant configurations for VAPI.
 * Uses prompts module for content and functions module for capabilities.
 */

const { 
  buildSystemPrompt, 
  buildFirstMessage, 
  buildEndCallMessage,
  getVoiceConfig 
} = require('../prompts');

const { getFunctions } = require('./functions');

/**
 * Model configuration defaults
 */
const MODEL_DEFAULTS = {
  provider: 'openai',
  model: 'gpt-4o-mini', // Chosen for cost/latency; tool rules + caps mitigate weaker function-calling
  temperature: 0.2,     // Lower for more consistent tone and phrasing (do NOT raise to fix dullness)
  maxTokens: 240        // 150 truncated warm turns mid-sentence, reading as a tone break
};

/**
 * Speech-to-text (transcriber) defaults. Deepgram Nova 3 (English).
 * Override per-business via ai_config.transcriber.
 */
const TRANSCRIBER_DEFAULTS = {
  provider: 'deepgram',
  model: 'nova-3',
  language: 'en'
};

/**
 * End-of-call analysis plan. Without this, VAPI never populates structured
 * analysis, so calls.sentiment is always null and intent falls back to keyword
 * matching. Structured data lands under analysis.structuredData on the report.
 */
const ANALYSIS_PLAN = {
  summaryPlan: {
    enabled: true
  },
  structuredDataPlan: {
    enabled: true,
    schema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'Primary reason for the call.',
          enum: ['booking', 'inquiry', 'complaint', 'modification', 'callback', 'general']
        },
        sentiment: {
          type: 'string',
          description: 'Overall caller sentiment during the call.',
          enum: ['positive', 'neutral', 'negative']
        }
      }
    }
  }
};

/**
 * Feature flags for different assistant types
 */
const ASSISTANT_TYPES = {
  BASIC: 'basic',
  BOOKING: 'booking',
  CALLBACK: 'callback',
  CUSTOM: 'custom'
};

/**
 * Build complete VAPI assistant configuration
 * @param {Object} business - Business object from DB
 * @param {Object} options - Configuration options
 * @returns {Object} Complete VAPI assistant config
 */
function buildAssistantConfig(business, options = {}) {
  const {
    type = ASSISTANT_TYPES.BASIC,
    enableBooking = false,
    enableCapture = false,
    enableCallback = false,
    voicePreset,  // undefined → getVoiceConfig falls back to DEFAULT_VOICE_PRESET
    customConfig = {}
  } = options;

  // Build prompts using the prompts module
  const systemPrompt = buildSystemPrompt(business, { 
    enableBooking,
    ...options 
  });

  const endCallMessage = buildEndCallMessage(business, { 
    enableBooking,
    ...options 
  });

  // Get voice configuration
  const voice = getVoiceConfig(business, { voicePreset, ...options });

  // Get functions based on features
  const functions = getFunctions({
    enableBooking,
    enableCapture,
    enableCallback,
    customFunctions: customConfig.functions
  });

  // Build system prompt - greeting is handled by firstMessage, not LLM
  const enhancedSystemPrompt = `${systemPrompt}

CONVERSATION START:
The caller has already been greeted. Continue the conversation naturally without adding another greeting.`;

  // Deterministic first message. Honors business.custom_greeting when set,
  // otherwise falls back to the warm default template.
  const firstMessage = buildFirstMessage(business, { enableBooking, ...options });

  // Per-business AI overrides (empty {} → pure Phase-1 defaults).
  const aiConfig = business?.ai_config || {};
  const aiModelOverrides = {};
  if (aiConfig.model) aiModelOverrides.model = aiConfig.model;
  if (aiConfig.temperature != null) aiModelOverrides.temperature = aiConfig.temperature;
  if (aiConfig.max_tokens != null) aiModelOverrides.maxTokens = aiConfig.max_tokens;

  // Build the complete config
  const config = {
    model: {
      ...MODEL_DEFAULTS,
      ...aiModelOverrides,
      ...customConfig.model,
      messages: [
        {
          role: 'system',
          content: enhancedSystemPrompt
        }
      ],
      ...(functions.length > 0 ? { functions } : {})
    },
    transcriber: { ...TRANSCRIBER_DEFAULTS, ...aiConfig.transcriber },
    voice,
    // Static first message for consistency (short to avoid TTS issues)
    firstMessage,
    firstMessageMode: 'assistant-speaks-first',
    endCallMessage,
    recordingEnabled: customConfig.recordingEnabled !== false, // default true

    // Automatically end call when AI says these phrases. Kept to the exact
    // configured closing variants only — bare 'Goodbye'/'Take care' were removed
    // because substring matching can kill a call mid-sentence ("I'll take care
    // of that for you").
    endCallPhrases: [
      'Thank you for calling',
      'Have a great day',
      'Have a wonderful day',
      'We look forward to seeing you',
      'Talk to you soon',
      endCallMessage  // Also use the custom end call message
    ],

    // Let the model end the call explicitly rather than relying only on phrase-sniffing.
    endCallFunctionEnabled: true,

    // Hang up if user is silent for this many seconds (secondary mitigation for
    // the tool loop). Per-business override via ai_config.silence_timeout.
    silenceTimeoutSeconds: aiConfig.silence_timeout || 45,

    // Hard ceiling on call length (no ceiling existed before).
    maxDurationSeconds: 600,

    // End-of-call analysis (populates sentiment + structured intent).
    analysisPlan: ANALYSIS_PLAN,

    ...customConfig.extraSettings
  };

  // Per-assistant server config so webhook auth + URL no longer depend on the
  // VAPI dashboard being hand-configured. Only attach when we have both a base
  // URL and a secret (otherwise we'd send a broken URL / unauthenticated events).
  const serverConfig = buildServerConfig();
  if (serverConfig) {
    config.server = serverConfig;
  }

  return config;
}

/**
 * Build the per-assistant server config (webhook URL + auth secret).
 * @returns {Object|null} Server config or null if env not configured
 */
function buildServerConfig() {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  const secret = process.env.VAPI_WEBHOOK_SECRET;

  if (!baseUrl || !secret) {
    return null;
  }

  return {
    url: `${baseUrl.replace(/\/$/, '')}/api/vapi-webhook`,
    secret
  };
}

/**
 * Quick config for basic assistant (no booking)
 * @param {Object} business - Business object
 * @param {Object} options - Additional options (voicePreset, etc.)
 * @returns {Object} Assistant config
 */
function buildBasicConfig(business, options = {}) {
  return buildAssistantConfig(business, {
    type: ASSISTANT_TYPES.BASIC,
    enableBooking: false,
    ...options
  });
}

/**
 * Quick config for booking-enabled assistant
 * @param {Object} business - Business object
 * @param {Object} calcomIntegration - Cal.com integration data
 * @param {Object} options - Additional options (voicePreset, etc.)
 * @returns {Object} Assistant config with booking functions
 */
function buildBookingConfig(business, calcomIntegration = null, options = {}) {
  // Only enable booking if Cal.com is properly configured
  const hasCalcom = !!(calcomIntegration?.access_token);

  return buildAssistantConfig(business, {
    type: ASSISTANT_TYPES.BOOKING,
    enableBooking: hasCalcom,
    enableCallback: !hasCalcom, // Enable callback as fallback
    ...options
  });
}

/**
 * Get default config when business not found
 * @returns {Object} Default assistant config
 */
function buildDefaultConfig() {
  return buildAssistantConfig(null, {
    type: ASSISTANT_TYPES.BASIC,
    enableBooking: false
    // voicePreset omitted → DEFAULT_VOICE_PRESET (Sarah)
  });
}

/**
 * Validate assistant configuration
 * @param {Object} config - Config to validate
 * @returns {Object} Validation result
 */
function validateConfig(config) {
  const errors = [];

  if (!config.model?.messages?.[0]?.content) {
    errors.push('Missing system prompt');
  }

  if (!config.firstMessage) {
    errors.push('Missing first message');
  }

  if (!config.voice?.voiceId) {
    errors.push('Missing voice configuration');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  // Config builders
  buildAssistantConfig,
  buildBasicConfig,
  buildBookingConfig,
  buildDefaultConfig,
  
  // Validation
  validateConfig,
  
  // Constants
  ASSISTANT_TYPES,
  MODEL_DEFAULTS,
  
  // Re-export functions for convenience
  getFunctions: require('./functions').getFunctions
};
