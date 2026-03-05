/**
 * Base Prompt Templates for VAPI AI Assistants
 * 
 * These are the foundation templates that get customized per business.
 * Eventually these can be moved to the database for per-business customization.
 */

/**
 * Base system prompt template - shared structure for all assistants
 */
const BASE_SYSTEM_TEMPLATE = `You are {{personality}} for {{businessName}}.

BUSINESS INFORMATION:
- Name: {{businessName}}
- Industry/Services: {{services}}
- Timezone: {{timezone}}
- Today's Hours: {{todayHours}}

{{customInstructions}}

CONVERSATION GUIDELINES:
{{guidelines}}

{{bookingSection}}

TONE: {{tone}}. Keep responses concise (1-2 sentences).`;

/**
 * Default conversation guidelines (generic)
 */
const DEFAULT_GUIDELINES = `1. Greet the caller warmly
2. Ask how you can help them today
3. Listen actively and respond naturally
4. Collect contact information if they want a callback
5. Provide helpful information about services
6. Thank them for calling before ending`;

/**
 * Booking-enabled conversation guidelines
 */
const BOOKING_GUIDELINES = `1. Greet the caller warmly
2. Ask if they'd like to schedule an appointment
3. Check availability using the checkAvailability function
4. Collect: full name, email, phone number, and preferred date/time
5. Create the booking using createBooking function
6. Confirm all appointment details
7. Thank them for calling`;

/**
 * First message templates
 */
const FIRST_MESSAGES = {
  generic: 'Hello! Thanks for calling. How can I help you today?',
  booking: 'Hello! Thanks for calling {{businessName}}. Would you like to schedule an appointment today?',
  inquiry: 'Hello! Thanks for calling {{businessName}}. How can I help you today?',
  custom: '{{customGreeting}}'
};

/**
 * End call messages
 */
const END_CALL_MESSAGES = {
  generic: 'Thank you for calling! Have a great day.',
  booking: 'Thank you for calling! We look forward to seeing you.',
  custom: '{{customClosing}}'
};

/**
 * Voice configuration presets
 */
const VOICE_PRESETS = {
  rachel: {
    provider: '11labs',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
    name: 'Rachel',
    description: 'Warm, professional'
  },
  adam: {
    provider: '11labs', 
    voiceId: 'pNInz6obpgDQGcFmaJgB',
    name: 'Adam',
    description: 'Professional, authoritative'
  },
  bella: {
    provider: '11labs',
    voiceId: 'EXAVITQu4vr4xnSDxMaL', 
    name: 'Bella',
    description: 'Friendly, approachable'
  },
  alloy: {
    provider: 'openai',
    voiceId: 'alloy',
    name: 'Alloy',
    description: 'OpenAI default'
  }
};

module.exports = {
  BASE_SYSTEM_TEMPLATE,
  DEFAULT_GUIDELINES,
  BOOKING_GUIDELINES,
  FIRST_MESSAGES,
  END_CALL_MESSAGES,
  VOICE_PRESETS
};
