export interface StorageCapabilityPackageInspectionOptions {
  readonly asarPath: string;
  readonly outputPath: string;
}

export declare function inspectStorageCapabilityPackage(
  options: StorageCapabilityPackageInspectionOptions
): Promise<Record<string, unknown>>;
