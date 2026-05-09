import { describe, expect, it } from "vitest";

import {
  createCandidateRecord,
  markRecordClicked,
  markRecordShown,
  transitionExpiredLearning
} from "../../src/core/state";

// @verifies glossa.vocabulary.state The test verifies vocabulary record creation, shown transitions, clicked learning state, and expiry.
describe("vocabulary state machine", () => {
  it("moves shown candidates into the known state", () => {
    const now = Date.parse("2026-05-03T00:00:00.000Z");
    const record = createCandidateRecord("test", "Test", "en", now);

    const shown = markRecordShown(record, now + 1_000);

    expect(shown.state).toBe("known");
    expect(shown.shownCount).toBe(1);
    expect(shown.lastShownAt).toBe(now + 1_000);
  });

  it("keeps clicked words visible in learning_active until the learning window expires", () => {
    const now = Date.parse("2026-05-03T00:00:00.000Z");
    const known = markRecordShown(createCandidateRecord("test", "Test", "en", now), now);

    const clicked = markRecordClicked(known, now + 1_000, 3);

    expect(clicked.state).toBe("learning_active");
    expect(clicked.clickCount).toBe(1);
    const expiresAt = clicked.expiresAt;
    expect(expiresAt).toBe(now + 1_000 + 3 * 24 * 60 * 60 * 1_000);
    expect(transitionExpiredLearning(clicked, expiresAt! - 1).state).toBe("learning_active");
    expect(transitionExpiredLearning(clicked, expiresAt!).state).toBe("known");
  });

  it("extends the learning window on repeated clicks", () => {
    const now = Date.parse("2026-05-03T00:00:00.000Z");
    const first = markRecordClicked(createCandidateRecord("test", "Test", "en", now), now, 3);
    const second = markRecordClicked(first, now + 2 * 24 * 60 * 60 * 1_000, 3);

    expect(second.clickCount).toBe(2);
    expect(second.expiresAt).toBe(now + 5 * 24 * 60 * 60 * 1_000);
  });
});
