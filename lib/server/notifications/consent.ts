/**
 * @file lib/server/notifications/consent.ts
 * The phrase a user must type to allow journal text to reach a third party.
 *
 * Lives outside the route module because Next.js restricts which names a route may
 * export, and both the API and its tests need this constant.
 */

export const EXCERPT_CONSENT_PHRASE = 'SEND MY JOURNAL TEXT';
