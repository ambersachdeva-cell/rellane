import {
  ModelFitSchema,
  isImmutableHuggingFaceResolverUrl,
  type HardwareProfile,
  type ModelFit,
  type OpenWeightModel,
  type QualityMode
} from "@cadrane/contracts";

const MODE_TARGET_PARAMETERS: Record<QualityMode, number> = {
  fast: 2,
  balanced: 7,
  quality: 14
};

export function rankOpenWeightModels(
  profile: HardwareProfile,
  catalog: OpenWeightModel[],
  mode: QualityMode = profile.recommendation
): ModelFit[] {
  return catalog
    .map((model) => scoreModelFit(profile, model, mode))
    .sort((left, right) =>
      right.score - left.score ||
      left.model.artifact.downloadBytes - right.model.artifact.downloadBytes ||
      left.model.id.localeCompare(right.model.id)
    );
}

export function scoreModelFit(
  profile: HardwareProfile,
  model: OpenWeightModel,
  mode: QualityMode
): ModelFit {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const supportedPlatform = asSupportedPlatform(profile.platform);
  const supportedArchitecture = asSupportedArchitecture(profile.architecture);
  const platformSupported = supportedPlatform !== null &&
    model.requirements.supportedPlatforms.includes(supportedPlatform);
  const architectureSupported = supportedArchitecture !== null &&
    model.requirements.supportedArchitectures.includes(supportedArchitecture);
  const targetKey = supportedPlatform !== null && supportedArchitecture !== null
    ? `${supportedPlatform}-${supportedArchitecture}` as const
    : null;
  const nativeVerified = targetKey !== null &&
    model.requirements.validatedTargets.includes(targetKey);
  const artifactUrlPinned =
    model.artifact.sourceUrl !== null &&
    model.artifact.repositoryRevision !== null &&
    model.artifact.filename !== null &&
    isImmutableHuggingFaceResolverUrl(
      model.artifact.sourceUrl,
      model.artifact.repositoryRevision,
      model.artifact.filename
    );
  const memoryHeadroom = profile.memoryBytes - model.requirements.comfortableMemoryBytes;
  const minimumMemoryHeadroom = profile.memoryBytes - model.requirements.minimumMemoryBytes;
  const diskHeadroom = profile.freeDiskBytes - model.requirements.minimumFreeDiskBytes;

  if (!platformSupported) {
    warnings.push("No packaged runtime is listed for this operating system.");
  }
  if (!architectureSupported) {
    warnings.push("No packaged runtime is listed for this processor architecture.");
  }
  if (minimumMemoryHeadroom < 0) {
    warnings.push("The model is likely to exceed installed system memory.");
  } else if (memoryHeadroom < 0) {
    warnings.push("It should run, but may make the computer feel constrained.");
  }
  if (diskHeadroom < 0) {
    warnings.push("There is not enough free storage for the model and safe download headroom.");
  }
  if (model.license.distributionReview !== "permissive-terms-reviewed") {
    warnings.push("Its weights license needs a separate review before one-click installation.");
  }
  if (model.artifact.sha256 === null || !artifactUrlPinned) {
    warnings.push("This catalog entry is not pinned for verified download yet.");
  }
  if (!nativeVerified) {
    warnings.push("This is a hardware estimate; this model has not passed native conformance on this target yet.");
  }

  const unsupported =
    !platformSupported ||
    !architectureSupported ||
    minimumMemoryHeadroom < 0 ||
    diskHeadroom < 0 ||
    model.license.distributionReview === "unreviewed";

  let fit: ModelFit["fit"];
  if (unsupported) {
    fit = "unsupported";
  } else if (
    memoryHeadroom >= model.artifact.downloadBytes &&
    diskHeadroom >= model.artifact.downloadBytes * 2
  ) {
    fit = "excellent";
  } else if (memoryHeadroom >= 0) {
    fit = "good";
  } else {
    fit = "tight";
  }

  if (fit === "excellent") {
    reasons.push("Estimated comfortable installed-memory and storage headroom for this computer.");
  } else if (fit === "good") {
    reasons.push("Estimated to fit installed memory and storage without the full comfort margin.");
  } else if (fit === "tight") {
    reasons.push("Meets the minimum, but a smaller model should feel more responsive.");
  } else {
    reasons.push("Blocked by a measured hardware, platform, or license requirement.");
  }

  const acceleration = profile.acceleration;
  if (acceleration !== "cpu" && acceleration !== "unknown") {
    reasons.push(`${accelerationLabel(acceleration)} hardware was detected.`);
  } else if (acceleration === "unknown" && profile.gpuName !== null) {
    warnings.push("A GPU was found, but no validated inference backend is active yet.");
  } else {
    warnings.push("CPU-only inference can be substantially slower.");
  }

  const target = MODE_TARGET_PARAMETERS[mode];
  const distance = Math.abs(Math.log2(model.parametersBillions / target));
  const modeScore = Math.max(0, 24 - Math.round(distance * 12));
  const fitScore = { excellent: 66, good: 54, tight: 38, unsupported: 0 }[fit];
  const accelerationScore = acceleration === "cpu" || acceleration === "unknown" ? 0 : 6;
  const licenseScore = model.license.distributionReview === "permissive-terms-reviewed" ? 4 : 0;
  const score = unsupported
    ? 0
    : Math.min(100, fitScore + modeScore + accelerationScore + licenseScore);

  return ModelFitSchema.parse({
    model,
    fit,
    score,
    platformVerification: nativeVerified ? "native-verified" : "estimated",
    recommendedMode: modeForParameters(model.parametersBillions),
    reasons,
    warnings,
    estimatedMemoryHeadroomBytes: memoryHeadroom,
    canInstall:
      !unsupported &&
      model.license.distributionReview === "permissive-terms-reviewed" &&
      artifactUrlPinned &&
      model.artifact.sha256 !== null &&
      model.artifact.repositoryRevision !== null &&
      model.artifact.filename !== null &&
      nativeVerified
  });
}

function modeForParameters(parametersBillions: number): QualityMode {
  if (parametersBillions <= 4.5) {
    return "fast";
  }
  if (parametersBillions <= 9) {
    return "balanced";
  }
  return "quality";
}

function accelerationLabel(
  acceleration: Exclude<HardwareProfile["acceleration"], "cpu" | "unknown">
): string {
  return {
    metal: "Apple Metal",
    cuda: "NVIDIA CUDA",
    hip: "AMD HIP",
    vulkan: "Vulkan",
    sycl: "Intel SYCL"
  }[acceleration];
}

function asSupportedPlatform(
  platform: HardwareProfile["platform"]
): "darwin" | "linux" | "win32" | null {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
}

function asSupportedArchitecture(
  architecture: string
): "arm64" | "x64" | null {
  return architecture === "arm64" || architecture === "x64" ? architecture : null;
}
