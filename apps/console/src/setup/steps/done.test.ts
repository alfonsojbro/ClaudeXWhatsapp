import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  capabilityItems,
  capabilityLabel,
  googleWarning,
  renderDone,
} from './done.js';
import { freshSetupState, markStep } from '../state.js';

describe('CAPABILITIES', () => {
  it('gives every item a phase and a sentence', () => {
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const capability of CAPABILITIES) {
      expect(Number.isInteger(capability.phase)).toBe(true);
      expect(capability.phase).toBeGreaterThan(0);
      expect(capability.text.trim().length).toBeGreaterThan(10);
    }
  });
});

describe('capabilityItems', () => {
  it('marks an item available only when its phase is merged', () => {
    const items = capabilityItems([1, 2]);
    for (const item of items) expect(item.available).toBe(item.phase === 1 || item.phase === 2);
  });

  it('promises nothing when nothing is merged', () => {
    expect(capabilityItems([]).every((item) => !item.available)).toBe(true);
  });
});

describe('capabilityLabel', () => {
  it('renders an unmerged phase with the "lands with" wording', () => {
    for (const item of capabilityItems([1])) {
      if (item.available) expect(capabilityLabel(item)).not.toContain('lands with');
      else expect(capabilityLabel(item)).toContain(`lands with phase ${String(item.phase)}`);
    }
  });

  it('never states an unmerged capability as a plain fact', () => {
    const unmerged = capabilityItems([]).map(capabilityLabel);
    expect(unmerged.every((label) => label.includes('lands with phase'))).toBe(true);
  });
});

describe('googleWarning', () => {
  it('warns when Google is connected but production was not confirmed', () => {
    const state = markStep(freshSetupState(0), 'google', 'done', 0);
    expect(googleWarning(state)).toContain('7 days');
  });

  it('is silent when production was confirmed', () => {
    const state = { ...markStep(freshSetupState(0), 'google', 'done', 0), googleConsentConfirmed: true };
    expect(googleWarning(state)).toBeNull();
  });

  it('is silent when Google was skipped entirely', () => {
    expect(googleWarning(markStep(freshSetupState(0), 'google', 'skipped', 0))).toBeNull();
    expect(googleWarning(freshSetupState(0))).toBeNull();
  });
});

describe('renderDone', () => {
  it('lists the steps that were skipped', () => {
    const state = markStep(markStep(freshSetupState(0), 'vault', 'skipped', 0), 'owner', 'done', 0);
    const view = renderDone(state, [1]);
    expect(view.skipped).toEqual(['vault']);
    expect(view.items).toHaveLength(CAPABILITIES.length);
  });
});
