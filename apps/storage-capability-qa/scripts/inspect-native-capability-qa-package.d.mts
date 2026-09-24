export interface NativeCapabilityQaPackageInspectionOptions {
  readonly appRoot: string;
  readonly buildManifestPath: string;
  readonly outputPath: string;
}

export declare function inspectNativeCapabilityQaPackage(
  options: NativeCapabilityQaPackageInspectionOptions
): Promise<Record<string, unknown>>;
