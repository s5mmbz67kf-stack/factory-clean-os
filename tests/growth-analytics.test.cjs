/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildFunnelStageRows,
  filterPrimaryAnalyticsEvents,
  inheritBookingConfirmationAttribution,
  normalizeGrowthEventOrigin,
} = require('../.test-build/growth-analytics.js');

test('normalizes legacy server origin to the database system value', () => {
  assert.equal(normalizeGrowthEventOrigin('server'), 'system');
  assert.equal(normalizeGrowthEventOrigin('system'), 'system');
  assert.equal(normalizeGrowthEventOrigin('os'), 'os');
  assert.equal(normalizeGrowthEventOrigin('web'), 'web');
  assert.equal(normalizeGrowthEventOrigin('unexpected'), 'web');
});

test('inherits only earlier same-session attribution for a confirmation', () => {
  const events = [
    {
      event_name: 'booking_confirmed', session_id: 'session-a', occurred_at: '2026-09-29T10:03:00Z',
      current_source: null, current_campaign_id: null, first_source: null, service_type: null,
    },
    {
      event_name: 'page_view', session_id: 'session-a', occurred_at: '2026-09-29T10:00:00Z',
      current_source: 'google', current_campaign_id: 'campaign-old', first_source: 'google', service_type: 'sofa',
    },
    {
      event_name: 'booking_started', session_id: 'session-a', occurred_at: '2026-09-29T10:02:00Z',
      current_source: 'meta', current_campaign_id: 'campaign-new', first_source: 'google', service_type: 'mattress',
    },
    {
      event_name: 'page_view', session_id: 'session-a', occurred_at: '2026-09-29T10:04:00Z',
      current_source: 'too-late', current_campaign_id: 'too-late', first_source: 'too-late', service_type: 'too-late',
    },
    {
      event_name: 'page_view', session_id: 'session-b', occurred_at: '2026-09-29T10:01:00Z',
      current_source: 'other-session', first_source: 'other-session',
    },
  ];

  const resolved = inheritBookingConfirmationAttribution(events);
  assert.equal(resolved[0].current_source, 'meta');
  assert.equal(resolved[0].current_campaign_id, 'campaign-new');
  assert.equal(resolved[0].first_source, 'google');
  assert.equal(resolved[0].service_type, 'mattress');
  assert.equal(resolved[1].current_source, 'google');
});

test('excludes every event in QA, Vercel, and Tag Assistant test sessions', () => {
  const events = [
    { event_name: 'page_view', session_id: 'qa-session', occurred_at: '2026-09-29T10:00:00Z', current_source: 'qa' },
    { event_name: 'booking_confirmed', session_id: 'qa-session', occurred_at: '2026-09-29T10:01:00Z', current_source: null },
    { event_name: 'page_view', session_id: 'preview-session', occurred_at: '2026-09-29T10:00:00Z', first_source: 'branch.vercel.com' },
    { event_name: 'page_view', session_id: 'tag-assistant-session', occurred_at: '2026-09-29T10:00:00Z', current_source: 'tagassistant.google.com' },
    { event_name: 'page_view', session_id: 'www-tag-assistant-session', occurred_at: '2026-09-29T10:00:00Z', first_source: 'www.tagassistant.google.com' },
    { event_name: 'page_view', session_id: 'real-session', occurred_at: '2026-09-29T10:00:00Z', current_source: 'google' },
  ];

  assert.deepEqual(filterPrimaryAnalyticsEvents(events).map((event) => event.session_id), ['real-session']);
});

test('builds one distinct-session funnel row per completed step', () => {
  const events = [
    { event_name: 'booking_started', session_id: 'one' },
    { event_name: 'booking_started', session_id: 'two' },
    { event_name: 'booking_step_completed', session_id: 'one', step_number: 1, booking_step: 'שירות' },
    { event_name: 'booking_step_completed', session_id: 'one', step_number: 1, booking_step: 'שירות' },
    { event_name: 'booking_step_completed', session_id: 'two', step_number: 1, booking_step: 'שירות' },
    { event_name: 'booking_step_completed', session_id: 'one', step_number: 2, booking_step: 'פרטים' },
    { event_name: 'booking_submitted', session_id: 'one' },
  ];

  const rows = buildFunnelStageRows(events);
  const started = rows.find((row) => row.key === 'booking_started');
  const stepOne = rows.find((row) => row.key === 'booking_step_completed:1');
  const stepTwo = rows.find((row) => row.key === 'booking_step_completed:2');
  assert.equal(started.sessions, 2);
  assert.equal(stepOne.sessions, 2);
  assert.equal(stepTwo.sessions, 1);
  assert.match(stepOne.label, /שלב 1 הושלם/);
  assert.ok(rows.indexOf(started) < rows.indexOf(stepOne));
  assert.ok(rows.indexOf(stepTwo) < rows.findIndex((row) => row.key === 'booking_submitted'));
});
