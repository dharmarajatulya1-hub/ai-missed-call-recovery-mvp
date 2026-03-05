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
  model: 'gpt-4',
  temperature: 0.7,
  maxTokens: 200
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
    enableCallback = false,
    voicePreset = 'rachel',
    customConfig = {}
  } = options;

  // Build prompts using the prompts module
  const systemPrompt = buildSystemPrompt(business, { 
    enableBooking,
    ...options 
  });

  const firstMessage = buildFirstMessage(business, { 
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
    enableCallback,
    customFunctions: customConfig.functions 
  });

  // Build the complete config
  const config = {
    model: {
      ...MODEL_DEFAULTS,
      ...customConfig.model,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        }
      ]
    },
    voice,
    firstMessage,
    endCallMessage,
    recordingEnabled: customConfig.recordingEnabled !== false, // default true
    ...customConfig.extraSettings
  };

  // Only add functions if there are any
  if (functions.length > 0) {
    config.functions = functions;
  }

  return config;
}

/**
 * Quick config for basic assistant (no booking)
 * @param {Object} business - Business object
 * @returns {Object} Assistant config
 */
function buildBasicConfig(business) {
  return buildAssistantConfig(business, {
    type: ASSISTANT_TYPES.BASIC,
    enableBooking: false
  });
}

/**
 * Quick config for booking-enabled assistant
 * @param {Object} business - Business object
 * @param {Object} calcomIntegration - Cal.com integration data
 * @returns {Object} Assistant config with booking functions
 */
function buildBookingConfig(business, calcomIntegration = null) {
  // Only enable booking if Cal.com is properly configured
  const hasCalcom = !!(calcomIntegration?.access_token);

  return buildAssistantConfig(business, {
    type: ASSISTANT_TYPES.BOOKING,
    enableBooking: hasCalcom,
    enableCallback: !hasCalcom // Enable callback as fallback
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
