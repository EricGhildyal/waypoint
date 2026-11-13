export interface StageModels {
  planning: string;
  implementation: string;
  review: string;
  testing: string;
}

/**
 * The models a new task starts with, from the per-stage defaults in Settings.
 * An easy task plans and reviews on the implementation model: the most capable
 * model is there for judgment-heavy work, and an easy task has little of it.
 * Shared by the new-task form (what it pre-selects) and the API (what it falls
 * back to), so the two cannot disagree.
 */
export function defaultModelsFor(
  difficulty: string,
  settings: Record<string, string | undefined>,
): StageModels {
  const base: StageModels = {
    planning: settings.defaultPlanningModel ?? "",
    implementation: settings.defaultImplementationModel ?? "",
    review: settings.defaultReviewModel ?? "",
    testing: settings.defaultTestingModel ?? "",
  };
  return difficulty === "EASY"
    ? { ...base, planning: base.implementation, review: base.implementation }
    : base;
}
