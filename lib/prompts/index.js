/**
 * Prompts Module
 * 
 * Central export for all prompt-related functionality.
 * 
 * Usage:
 *   const { buildSystemPrompt, buildFirstMessage } = require('../lib/prompts');
 *   const prompt = buildSystemPrompt(business, { enableBooking: true });
 */

const templates = require('./templates');
const builders = require('./builders');

module.exports = {
  // Templates (for advanced customization)
  ...templates,
  
  // Builders (main API)
  ...builders
};
