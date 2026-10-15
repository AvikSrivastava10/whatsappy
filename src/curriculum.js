const lessons = [
  ['Generalization', 'Interpret a train/test performance gap'],
  ['Precision and recall', 'Choose a metric based on the cost of mistakes'],
  ['Data leakage', 'Identify a subtle preprocessing leak'],
  ['Cross-validation', 'Select a split strategy for dependent observations'],
  ['Regularization', 'Compare behavior as penalty strength changes'],
  ['Decision thresholds', 'Balance class imbalance and error costs'],
  ['Model selection', 'Interpret evidence without tuning on the test set'],
  ['Ensembles', 'Compare model diversity and correlated errors'],
  ['Optimization', 'Diagnose learning behavior from several observations'],
  ['Embeddings and retrieval', 'Evaluate representation and retrieval tradeoffs'],
  ['LLM evaluation', 'Separate retrieval failure, unsupported generation, and evaluation bias'],
  ['End-to-end ML', 'Combine evaluation, leakage, distribution shift, and deployment constraints']
];

export function lesson(week) {
  if (!Number.isInteger(week) || week < 1 || week > 520) throw new Error('Week must be 1..520');
  const [topic, objective] = lessons[(week - 1) % lessons.length];
  const cycle = Math.floor((week - 1) / lessons.length);
  return { week, topic, objective, level: week + 1,
    rubric: `Start above beginner. This is progression step ${week}. Require progressively more reasoning than the prior week, not obscure terminology. ${cycle ? `Advanced revisit cycle ${cycle}: combine this topic with prior topics, realistic tradeoffs and short calculations.` : 'Move from simple application toward multi-step diagnosis and tradeoffs.'}` };
}
