/**
 * MESTARO AR Scenario Controller
 *
 * Независим от конкретного 3D-движка. Сценарий управляет шагами и проверками,
 * а сайт связывает события ar:* с Three.js, Babylon.js или другим просмотрщиком.
 */

export async function loadArScenario({
  scenarioUrl = "./scenario.json",
  nodeMapUrl = "./model-node-map.template.json"
} = {}) {
  const [scenarioResponse, nodeMapResponse] = await Promise.all([
    fetch(scenarioUrl),
    fetch(nodeMapUrl)
  ]);

  if (!scenarioResponse.ok) {
    throw new Error("Не удалось загрузить AR-сценарий: " + scenarioResponse.status);
  }

  if (!nodeMapResponse.ok) {
    throw new Error("Не удалось загрузить карту 3D-узлов: " + nodeMapResponse.status);
  }

  const [scenario, nodeMap] = await Promise.all([
    scenarioResponse.json(),
    nodeMapResponse.json()
  ]);

  validateScenarioPackage(scenario, nodeMap);

  return { scenario, nodeMap };
}

export class ArScenarioController extends EventTarget {
  constructor({ scenario, nodeMap, sessionContext = {} }) {
    super();
    validateScenarioPackage(scenario, nodeMap);

    this.scenario = scenario;
    this.nodeMap = nodeMap;
    this.sessionContext = {
      equipmentModel: scenario.equipment.model,
      ...sessionContext
    };
    this.currentIndex = -1;
    this.startedAt = null;
    this.completedAt = null;
    this.stepResults = new Map();
    this.openWarnings = [];
    this.selectedConfigurationId = null;
    this.configurationAppliedActionIds = new Set();
    this.status = "idle";
  }

  get currentStep() {
    return this.currentIndex >= 0
      ? this.scenario.steps[this.currentIndex]
      : null;
  }

  get progress() {
    const total = this.scenario.steps.length;
    const completed = Array.from(this.stepResults.values())
      .filter((result) => result.status === "passed" || result.status === "not_applicable")
      .length;

    return {
      current: this.currentIndex + 1,
      completed,
      total,
      percent: total ? Math.round((completed / total) * 100) : 0
    };
  }

  start() {
    if (this.status !== "idle") {
      return;
    }

    this.status = "active";
    this.startedAt = new Date().toISOString();

    this.dispatchEvent(new CustomEvent("ar:scenario-start", {
      detail: {
        scenario: this.scenario,
        sessionContext: this.sessionContext,
        startedAt: this.startedAt
      }
    }));

    this.goToStep(0);
  }

  goToStep(stepIdOrIndex) {
    const nextIndex = typeof stepIdOrIndex === "number"
      ? stepIdOrIndex
      : this.scenario.steps.findIndex((step) => step.id === stepIdOrIndex);

    if (nextIndex < 0 || nextIndex >= this.scenario.steps.length) {
      throw new RangeError("Шаг AR-сценария не найден: " + stepIdOrIndex);
    }

    this.currentIndex = nextIndex;
    const step = this.currentStep;
    const binding = buildStepBinding(step, this.nodeMap, this.scenario.sourceMedia);

    if (!this.stepResults.has(step.id)) {
      this.stepResults.set(step.id, {
        stepId: step.id,
        status: "in_progress",
        startedAt: new Date().toISOString(),
        completedAt: null,
        actions: {},
        warnings: []
      });
    } else if (this.stepResults.get(step.id).status === "pending") {
      const pendingResult = this.stepResults.get(step.id);
      pendingResult.status = "in_progress";
      pendingResult.startedAt = new Date().toISOString();
    }

    this.dispatchEvent(new CustomEvent("ar:step-change", {
      detail: {
        step,
        index: this.currentIndex,
        progress: this.progress,
        binding
      }
    }));

    return step;
  }

  submitAction(actionId, value) {
    const step = this.currentStep;
    if (!step) {
      throw new Error("Сценарий ещё не запущен.");
    }

    const action = step.actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new Error("Действие не относится к текущему шагу: " + actionId);
    }

    const result = this.stepResults.get(step.id);
    result.actions[actionId] = {
      type: action.type,
      value,
      recordedAt: new Date().toISOString(),
      ...(action.derivedFrom && this.selectedConfigurationId
        ? { source: "manual_override" }
        : {})
    };

    if (action.type === "pass_fail" && value === "fail") {
      result.status = "failed";
    }

    this.dispatchEvent(new CustomEvent("ar:action-recorded", {
      detail: {
        step,
        action,
        value,
        canAdvance: this.canAdvance()
      }
    }));

    return this.canAdvance();
  }

  overrideConfigurationAction(actionId, value) {
    if (!this.selectedConfigurationId) {
      throw new Error("Сначала выберите базовую комплектацию WATO EX-35.");
    }

    const match = findScenarioAction(this.scenario, actionId);
    if (!match?.action.derivedFrom) {
      throw new TypeError("Действие не является составляющей комплектации: " + actionId);
    }

    const donor = (this.scenario.configurations || []).find((configuration) => {
      return configuration.actionDefaults?.[actionId] === value;
    });
    if (!donor) {
      throw new RangeError("Значение отсутствует в утверждённых комплектациях v4: " + value);
    }

    this.submitAction(actionId, value);

    for (const dependentActionId of CONFIGURATION_OVERRIDE_DEPENDENCIES[actionId] || []) {
      const dependentMatch = findScenarioAction(this.scenario, dependentActionId);
      if (!dependentMatch) continue;

      const result = this.stepResults.get(dependentMatch.step.id);
      const recorded = result?.actions[dependentActionId];
      if (recorded) {
        delete result.actions[dependentActionId];
      }

      if (!Object.hasOwn(donor.actionDefaults || {}, dependentActionId)) continue;
      if (!this.stepResults.has(dependentMatch.step.id)) {
        this.stepResults.set(dependentMatch.step.id, {
          stepId: dependentMatch.step.id,
          status: "pending",
          startedAt: null,
          completedAt: null,
          actions: {},
          warnings: []
        });
      }

      this.stepResults.get(dependentMatch.step.id).actions[dependentActionId] = {
        type: dependentMatch.action.type,
        value: donor.actionDefaults[dependentActionId],
        recordedAt: new Date().toISOString(),
        source: "configuration_override"
      };
      this.configurationAppliedActionIds.add(dependentActionId);
    }

    this.dispatchEvent(new CustomEvent("ar:configuration-override", {
      detail: { actionId, value, donorConfigurationId: donor.id }
    }));

    return donor;
  }

  applyConfiguration(configurationId) {
    const configuration = (this.scenario.configurations || [])
      .find((candidate) => candidate.id === configurationId);

    if (!configuration) {
      throw new RangeError("Комплектация WATO EX-35 не найдена: " + configurationId);
    }

    for (const actionId of this.configurationAppliedActionIds) {
      const match = findScenarioAction(this.scenario, actionId);
      const recorded = match && this.stepResults.get(match.step.id)?.actions[actionId];
      if (recorded?.source === "configuration_profile" || recorded?.source === "configuration_override") {
        delete this.stepResults.get(match.step.id).actions[actionId];
      }
    }

    this.configurationAppliedActionIds.clear();
    const recordedAt = new Date().toISOString();

    for (const [actionId, value] of Object.entries(configuration.actionDefaults || {})) {
      const match = findScenarioAction(this.scenario, actionId);
      if (!match) {
        throw new TypeError("Комплектация ссылается на неизвестное действие: " + actionId);
      }

      if (!this.stepResults.has(match.step.id)) {
        this.stepResults.set(match.step.id, {
          stepId: match.step.id,
          status: "pending",
          startedAt: null,
          completedAt: null,
          actions: {},
          warnings: []
        });
      }

      this.stepResults.get(match.step.id).actions[actionId] = {
        type: match.action.type,
        value,
        recordedAt,
        source: "configuration_profile"
      };
      this.configurationAppliedActionIds.add(actionId);
    }

    this.selectedConfigurationId = configuration.id;
    this.sessionContext.equipmentConfigurationId = configuration.id;
    this.dispatchEvent(new CustomEvent("ar:configuration-applied", {
      detail: { configuration, canAdvance: this.canAdvance() }
    }));

    return configuration;
  }

  addWarning(message, { blocking = false } = {}) {
    const warning = {
      message,
      blocking,
      stepId: this.currentStep ? this.currentStep.id : null,
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };

    this.openWarnings.push(warning);

    if (this.currentStep) {
      this.stepResults.get(this.currentStep.id).warnings.push(warning);
    }

    this.dispatchEvent(new CustomEvent("ar:warning", {
      detail: warning
    }));

    return warning;
  }

  resolveWarning(index) {
    const warning = this.openWarnings[index];
    if (!warning) {
      throw new RangeError("Предупреждение не найдено.");
    }

    warning.resolvedAt = new Date().toISOString();
    this.dispatchEvent(new CustomEvent("ar:warning-resolved", {
      detail: warning
    }));
  }

  canAdvance() {
    const step = this.currentStep;
    if (!step) {
      return false;
    }

    const result = this.stepResults.get(step.id);
    const markedNotApplicable = step.kind === "optional"
      && Object.values(result.actions)
        .some((recorded) => recorded.value === "not_applicable");

    const requiredActionsComplete = step.actions
      .filter((action) => {
        if (!action.required) {
          return false;
        }
        if (!markedNotApplicable) {
          return true;
        }
        return action.type === "confirm_or_not_applicable"
          || action.type === "input_choice";
      })
      .every((action) => isActionComplete(action, result.actions[action.id]));

    const applicabilityConsistent = !markedNotApplicable || step.actions
      .filter((action) => {
        return action.required && (
          action.type === "confirm_or_not_applicable"
          || (action.type === "input_choice"
            && action.options?.includes("not_applicable"))
        );
      })
      .every((action) => {
        return result.actions[action.id]?.value === "not_applicable";
      });

    const hasFailedDeviceTest = !markedNotApplicable && step.actions.some((action) => {
      const recorded = result.actions[action.id];
      return action.type === "pass_fail" && recorded && recorded.value !== "pass";
    });

    const hasBlockingWarning = this.openWarnings.some((warning) => {
      return warning.blocking && !warning.resolvedAt;
    });

    return requiredActionsComplete
      && applicabilityConsistent
      && !hasFailedDeviceTest
      && !hasBlockingWarning;
  }

  passCurrentStep() {
    const step = this.currentStep;
    if (!step) {
      throw new Error("Сценарий ещё не запущен.");
    }

    if (!this.canAdvance()) {
      this.dispatchEvent(new CustomEvent("ar:validation", {
        detail: {
          step,
          passed: false,
          validation: step.validation
        }
      }));
      return false;
    }

    const result = this.stepResults.get(step.id);
    const notApplicable = Object.values(result.actions)
      .some((recorded) => recorded.value === "not_applicable");

    result.status = notApplicable && step.kind === "optional"
      ? "not_applicable"
      : "passed";
    result.completedAt = new Date().toISOString();

    this.dispatchEvent(new CustomEvent("ar:validation", {
      detail: {
        step,
        passed: true,
        result
      }
    }));

    return true;
  }

  next() {
    if (!this.passCurrentStep()) {
      return false;
    }

    if (this.currentIndex === this.scenario.steps.length - 1) {
      return this.complete();
    }

    this.goToStep(this.currentIndex + 1);
    return true;
  }

  previous() {
    if (this.currentIndex <= 0) {
      return false;
    }

    this.goToStep(this.currentIndex - 1);
    return true;
  }

  complete() {
    const requiredIds = new Set(this.scenario.completion.requiredStepIds);
    const requiredPassed = Array.from(requiredIds).every((stepId) => {
      const result = this.stepResults.get(stepId);
      return result && result.status === "passed";
    });

    const optionalIds = new Set(this.scenario.completion.optionalStepIds || []);
    const optionalCompleted = Array.from(optionalIds).every((stepId) => {
      const result = this.stepResults.get(stepId);
      return result && (result.status === "passed" || result.status === "not_applicable");
    });

    const unresolvedBlockingWarnings = this.openWarnings
      .filter((warning) => warning.blocking && !warning.resolvedAt);

    if (!requiredPassed || !optionalCompleted || unresolvedBlockingWarnings.length) {
      this.dispatchEvent(new CustomEvent("ar:completion-blocked", {
        detail: {
          requiredPassed,
          optionalCompleted,
          unresolvedBlockingWarnings
        }
      }));
      return false;
    }

    this.status = "completed";
    this.completedAt = new Date().toISOString();
    const report = this.buildReport();

    this.dispatchEvent(new CustomEvent("ar:scenario-complete", {
      detail: report
    }));

    return report;
  }

  buildReport() {
    const equipmentConfiguration = (this.scenario.configurations || [])
      .find((candidate) => candidate.id === this.selectedConfigurationId) || null;

    return {
      scenarioId: this.scenario.id,
      scenarioRevision: this.scenario.revision,
      manualDocumentId: this.scenario.referenceDocuments?.[0]?.id || null,
      equipmentModel: this.scenario.equipment.model,
      equipmentConfiguration: equipmentConfiguration ? {
        id: equipmentConfiguration.id,
        label: equipmentConfiguration.label,
        sourceWorkbook: equipmentConfiguration.sourceWorkbook
      } : null,
      configurationSelections: extractConfigurationSelections(this.stepResults),
      configurationOverrides: extractConfigurationOverrides(
        this.scenario,
        this.stepResults,
        equipmentConfiguration
      ),
      ...this.sessionContext,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      status: this.status,
      progress: this.progress,
      stepResults: Array.from(this.stepResults.values()),
      warnings: this.openWarnings
    };
  }
}

const CONFIGURATION_OVERRIDE_DEPENDENCIES = {
  "select-vaporizer-configuration": ["select-installed-vaporizers"],
  "select-gas-module-configuration": [
    "confirm-co2-module",
    "confirm-co2-water-separator",
    "select-ag-module-variant"
  ],
  "select-aspirator-configuration": [
    "confirm-aspirator-mount",
    "confirm-aspirator-lines"
  ],
  "select-agss-configuration": [
    "select-active-agss-flow",
    "confirm-agss-mount",
    "confirm-agss-single-connector",
    "confirm-agss-hospital-line",
    "confirm-agss-applicability"
  ],
  "select-power-configuration": ["select-power-variant"]
};

export function createThreeSceneIndex(scene) {
  const exact = new Map();
  const normalized = new Map();

  if (!scene || typeof scene.traverse !== "function") {
    throw new TypeError("Ожидается корневой объект Three.js с методом traverse().");
  }

  scene.traverse((object) => {
    if (!object.name) {
      return;
    }
    exact.set(object.name, object);
    normalized.set(normalizeName(object.name), object);
  });

  return {
    exact,
    normalized,
    allNames: Array.from(exact.keys()).sort()
  };
}

export function resolveLogicalNodes(logicalIds, nodeMap, sceneIndex) {
  return logicalIds.map((logicalId) => {
    const mapping = nodeMap.nodes[logicalId];
    if (!mapping) {
      return {
        logicalId,
        object: null,
        matchedBy: null,
        status: "logical_id_missing"
      };
    }

    const candidates = [
      mapping.glbNodeName,
      ...(mapping.aliases || [])
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (sceneIndex.exact.has(candidate)) {
        return {
          logicalId,
          object: sceneIndex.exact.get(candidate),
          matchedBy: candidate,
          status: "resolved"
        };
      }

      const normalizedCandidate = normalizeName(candidate);
      if (sceneIndex.normalized.has(normalizedCandidate)) {
        return {
          logicalId,
          object: sceneIndex.normalized.get(normalizedCandidate),
          matchedBy: candidate,
          status: "resolved_normalized"
        };
      }
    }

    return {
      logicalId,
      object: null,
      matchedBy: null,
      status: mapping.fallback ? "fallback_required" : "unmapped"
    };
  });
}

export function buildTimestampUrl(baseUrl, startSec) {
  const url = new URL(baseUrl);
  url.searchParams.set("t", String(startSec) + "s");
  return url.toString();
}

export function bindScenarioToThreeScene(controller, {
  scene,
  clearHighlights,
  highlightObjects,
  focusCamera,
  showAnnotations
}) {
  const sceneIndex = createThreeSceneIndex(scene);

  const onStepChange = (event) => {
    const { step, binding } = event.detail;
    const resolved = resolveLogicalNodes(binding.highlight, controller.nodeMap, sceneIndex);
    const objects = resolved
      .filter((item) => item.object)
      .map((item) => item.object);

    if (typeof clearHighlights === "function") {
      clearHighlights();
    }
    if (typeof highlightObjects === "function") {
      highlightObjects(objects, step.visual.effect);
    }
    if (typeof focusCamera === "function") {
      focusCamera({
        preset: binding.cameraPreset,
        presetConfig: binding.cameraPresetConfig,
        objects
      });
    }
    if (typeof showAnnotations === "function") {
      showAnnotations(step.visual.annotations, resolved);
    }

    controller.dispatchEvent(new CustomEvent("ar:model-binding-result", {
      detail: {
        stepId: step.id,
        resolved,
        unmapped: resolved.filter((item) => !item.object)
      }
    }));
  };

  controller.addEventListener("ar:step-change", onStepChange);

  return {
    sceneIndex,
    unbind() {
      controller.removeEventListener("ar:step-change", onStepChange);
    }
  };
}

function buildStepBinding(step, nodeMap, sourceMedia) {
  const highlight = step.visual.highlight || step.objects;
  const cameraPreset = step.visual.cameraPreset;

  return {
    logicalObjects: step.objects,
    highlight,
    cameraPreset,
    cameraPresetConfig: nodeMap.cameraPresets[cameraPreset] || null,
    annotations: step.visual.annotations || [],
    effect: step.visual.effect,
    sourceAuthority: step.sourceAuthority,
    manualRefs: step.manualRefs || [],
    sourceUrl: buildTimestampUrl(sourceMedia.url, step.source.startSec)
  };
}

function isActionComplete(action, recorded) {
  if (!recorded) {
    return false;
  }

  if (action.type === "confirm") {
    return recorded.value === true || recorded.value === "confirmed";
  }

  if (action.type === "confirm_or_not_applicable") {
    return recorded.value === "confirmed" || recorded.value === "not_applicable";
  }

  if (action.type === "pass_fail") {
    return recorded.value === "pass";
  }

  if (action.type === "multi_choice") {
    if (!Array.isArray(recorded.value)) {
      return false;
    }
    return !Array.isArray(action.options)
      || recorded.value.every((value) => action.options.includes(value));
  }

  if (action.type === "input_text_optional") {
    return true;
  }

  const hasValue = recorded.value !== undefined
    && recorded.value !== null
    && recorded.value !== "";

  if (!hasValue) {
    return false;
  }

  if (action.type === "input_choice" && Array.isArray(action.options)) {
    return action.options.includes(recorded.value);
  }

  return true;
}

function extractConfigurationSelections(stepResults) {
  const configuration = {};

  for (const result of stepResults.values()) {
    for (const [actionId, recorded] of Object.entries(result.actions)) {
      if (actionId.startsWith("select-")) {
        configuration[actionId] = recorded.value;
      }
    }
  }

  return configuration;
}

function extractConfigurationOverrides(scenario, stepResults, baseConfiguration) {
  if (!baseConfiguration) return {};
  const selections = extractConfigurationSelections(stepResults);
  const overrides = {};

  for (const step of scenario.steps || []) {
    for (const action of step.actions || []) {
      if (!action.derivedFrom) continue;
      const current = selections[action.id];
      const original = baseConfiguration.actionDefaults?.[action.id];
      if (current !== undefined && current !== original) {
        overrides[action.id] = { from: original, to: current };
      }
    }
  }

  return overrides;
}

function normalizeName(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, "");
}

function findScenarioAction(scenario, actionId) {
  for (const step of scenario.steps || []) {
    const action = step.actions?.find((candidate) => candidate.id === actionId);
    if (action) {
      return { step, action };
    }
  }
  return null;
}

function assertConfigurations(scenario) {
  const configurations = scenario.configurations || [];
  if (!configurations.length) {
    throw new TypeError("Некорректный scenario.json: отсутствуют комплектации WATO EX-35.");
  }

  const ids = new Set();
  const selector = findScenarioAction(scenario, "select-equipment-configuration")?.action;
  for (const configuration of configurations) {
    if (!configuration.id || ids.has(configuration.id)) {
      throw new TypeError("Некорректный или повторяющийся id комплектации: " + configuration.id);
    }
    if (!selector?.options?.includes(configuration.id)) {
      throw new TypeError("Комплектация отсутствует в селекторе: " + configuration.id);
    }

    for (const [actionId, value] of Object.entries(configuration.actionDefaults || {})) {
      const match = findScenarioAction(scenario, actionId);
      if (!match || !isActionComplete(match.action, { value })) {
        throw new TypeError(
          "Некорректное значение комплектации " + configuration.id
          + " для действия " + actionId
        );
      }
    }
    ids.add(configuration.id);
  }
}

function assertScenario(scenario) {
  if (!scenario || !Array.isArray(scenario.steps) || !scenario.steps.length) {
    throw new TypeError("Некорректный scenario.json: отсутствуют шаги.");
  }

  const ids = new Set();
  const documentIds = new Set(
    (scenario.referenceDocuments || []).map((document) => document.id)
  );

  if (!documentIds.size) {
    throw new TypeError("Некорректный scenario.json: отсутствуют referenceDocuments.");
  }

  scenario.steps.forEach((step, index) => {
    if (!step.id || ids.has(step.id)) {
      throw new TypeError("Некорректный или повторяющийся id шага: " + step.id);
    }
    if (step.order !== index) {
      throw new TypeError("Порядок шагов нарушен у " + step.id);
    }
    if (!Array.isArray(step.manualRefs) || !step.manualRefs.length) {
      throw new TypeError("У шага отсутствует ссылка на руководство: " + step.id);
    }
    step.manualRefs.forEach((reference) => {
      if (!documentIds.has(reference.documentId)) {
        throw new TypeError(
          "Шаг ссылается на неизвестный документ: "
          + step.id + " -> " + reference.documentId
        );
      }
    });

    const actionIds = new Set();
    step.actions.forEach((action) => {
      if (!action.id || actionIds.has(action.id)) {
        throw new TypeError("Повторяющийся id действия в " + step.id + ": " + action.id);
      }
      actionIds.add(action.id);
    });
    ids.add(step.id);
  });

  const requiredIds = new Set(scenario.completion?.requiredStepIds || []);
  const optionalIds = new Set(scenario.completion?.optionalStepIds || []);

  for (const stepId of [...requiredIds, ...optionalIds]) {
    if (!ids.has(stepId)) {
      throw new TypeError("completion ссылается на неизвестный шаг: " + stepId);
    }
  }

  for (const stepId of requiredIds) {
    if (optionalIds.has(stepId)) {
      throw new TypeError("Шаг одновременно обязательный и опциональный: " + stepId);
    }
  }

  scenario.steps.forEach((step) => {
    const expectedKind = requiredIds.has(step.id) ? "mandatory" : "optional";
    if (step.kind !== expectedKind) {
      throw new TypeError(
        "kind шага не соответствует completion: " + step.id
      );
    }
  });
}

function assertNodeMap(nodeMap) {
  if (!nodeMap || !nodeMap.nodes || !nodeMap.cameraPresets) {
    throw new TypeError("Некорректная карта 3D-узлов.");
  }
}

function assertScenarioNodeCoverage(scenario, nodeMap) {
  const missingNodes = new Set();
  const missingPresets = new Set();

  scenario.steps.forEach((step) => {
    const logicalIds = [
      ...(step.objects || []),
      ...(step.visual?.highlight || []),
      ...((step.visual?.annotations || []).map((annotation) => annotation.object))
    ];

    logicalIds.forEach((logicalId) => {
      if (!nodeMap.nodes[logicalId]) {
        missingNodes.add(logicalId);
      }
    });

    if (!nodeMap.cameraPresets[step.visual?.cameraPreset]) {
      missingPresets.add(step.visual?.cameraPreset);
    }
  });

  if (missingNodes.size || missingPresets.size) {
    throw new TypeError(
      "Неполная карта 3D-привязок. Узлы: "
      + Array.from(missingNodes).join(", ")
      + "; ракурсы: "
      + Array.from(missingPresets).join(", ")
    );
  }
}

export function validateScenarioPackage(scenario, nodeMap) {
  assertScenario(scenario);
  assertConfigurations(scenario);
  assertNodeMap(nodeMap);
  assertScenarioNodeCoverage(scenario, nodeMap);

  if (nodeMap.scenarioId !== scenario.id) {
    throw new TypeError(
      "scenarioId карты 3D-узлов не совпадает с id сценария."
    );
  }

  return {
    scenarioId: scenario.id,
    revision: scenario.revision,
    steps: scenario.steps.length,
    logicalNodes: Object.keys(nodeMap.nodes).length,
    cameraPresets: Object.keys(nodeMap.cameraPresets).length
  };
}
