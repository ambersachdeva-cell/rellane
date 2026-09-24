import {
  LicenseAcknowledgementSchema,
  ModelInstallStartIntentSchema,
  type LicenseAcknowledgement
} from "@cadrane/contracts";
import { createHash, randomUUID } from "node:crypto";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} from "node:path";
import { z } from "zod";
import { RuntimeBoundaryError } from "../errors.js";
import {
  NodeManagedModelFileSystem,
  type ManagedModelFileSystem
} from "./model-download-files.js";

const ACKNOWLEDGEMENT_DIRECTORY = "license-acknowledgements";
const MAXIMUM_STORED_ACKNOWLEDGEMENT_BYTES = 8 * 1024;

const StoredAcknowledgementSchema = z.object({
  schemaVersion: z.literal(1),
  acknowledgement: LicenseAcknowledgementSchema
}).strict();

export interface LicenseAcknowledgementStore {
  load(modelId: string): Promise<LicenseAcknowledgement | null>;
  save(acknowledgement: LicenseAcknowledgement): Promise<void>;
}

export interface FileLicenseAcknowledgementStoreOptions {
  readonly rootDirectory: string;
  readonly fileSystem?: ManagedModelFileSystem;
}

export class FileLicenseAcknowledgementStore
implements LicenseAcknowledgementStore {
  private readonly rootDirectory: string;
  private readonly acknowledgementDirectory: string;
  private readonly fileSystem: ManagedModelFileSystem;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FileLicenseAcknowledgementStoreOptions) {
    if (!isAbsolute(options.rootDirectory)) {
      throw securityBoundary("The license acknowledgement store root must be absolute.");
    }
    this.rootDirectory = resolve(options.rootDirectory);
    if (this.rootDirectory === parse(this.rootDirectory).root) {
      throw securityBoundary(
        "The license acknowledgement store cannot use a filesystem root."
      );
    }
    this.acknowledgementDirectory = join(
      this.rootDirectory,
      ACKNOWLEDGEMENT_DIRECTORY
    );
    this.fileSystem = options.fileSystem ?? new NodeManagedModelFileSystem();
  }

  async load(modelId: string): Promise<LicenseAcknowledgement | null> {
    const path = this.acknowledgementPath(modelId);
    await this.prepareDirectories();
    const size = await this.fileSystem.regularFileSize(path);
    if (size === null || size > MAXIMUM_STORED_ACKNOWLEDGEMENT_BYTES) {
      return null;
    }
    const encoded = await this.fileSystem.readUtf8(path);
    await this.assertDirectories();
    if (encoded === null || Buffer.byteLength(encoded, "utf8") !== size) {
      return null;
    }
    try {
      const decoded: unknown = JSON.parse(encoded);
      const parsed = StoredAcknowledgementSchema.safeParse(decoded);
      return parsed.success ? parsed.data.acknowledgement : null;
    } catch {
      return null;
    }
  }

  save(acknowledgement: LicenseAcknowledgement): Promise<void> {
    const parsed = LicenseAcknowledgementSchema.safeParse(acknowledgement);
    if (!parsed.success) {
      return Promise.reject(badRequest(
        "The license acknowledgement is malformed."
      ));
    }
    const action = this.writeQueue.then(() => this.saveSerial(parsed.data));
    this.writeQueue = action.catch(() => undefined);
    return action;
  }

  private async saveSerial(
    acknowledgement: LicenseAcknowledgement
  ): Promise<void> {
    const path = this.acknowledgementPath(acknowledgement.modelId);
    await this.prepareDirectories();
    await this.fileSystem.regularFileSize(path);

    const encoded = JSON.stringify({
      schemaVersion: 1,
      acknowledgement
    });
    if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_STORED_ACKNOWLEDGEMENT_BYTES) {
      throw badRequest("The license acknowledgement exceeds its storage boundary.");
    }

    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    this.assertWithinRoot(temporaryPath);
    await this.fileSystem.replacePrivateFile(path, temporaryPath, encoded);
    await this.assertDirectories();

    const stored = await this.load(acknowledgement.modelId);
    if (
      stored === null ||
      JSON.stringify(stored) !== JSON.stringify(acknowledgement)
    ) {
      throw storageUnavailable(
        "The license acknowledgement could not be verified after storage."
      );
    }
  }

  private acknowledgementPath(modelId: string): string {
    const parsed = ModelInstallStartIntentSchema.safeParse({ modelId });
    if (!parsed.success) {
      throw badRequest("The model ID for the license acknowledgement is invalid.");
    }
    const path = join(
      this.acknowledgementDirectory,
      `${modelIdDigest(parsed.data.modelId)}.license-ack.json`
    );
    this.assertWithinRoot(path);
    return path;
  }

  private async prepareDirectories(): Promise<void> {
    await this.fileSystem.ensurePrivateDirectory(this.rootDirectory);
    await this.fileSystem.ensurePrivateDirectory(this.acknowledgementDirectory);
    await this.assertDirectories();
  }

  private async assertDirectories(): Promise<void> {
    await this.fileSystem.assertRealDirectory(this.rootDirectory);
    await this.fileSystem.assertRealDirectory(this.acknowledgementDirectory);
  }

  private assertWithinRoot(candidate: string): void {
    const pathFromRoot = relative(this.rootDirectory, candidate);
    if (
      pathFromRoot === "" ||
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw securityBoundary(
        "A license acknowledgement path escaped its private store boundary."
      );
    }
  }
}

function modelIdDigest(modelId: string): string {
  return createHash("sha256").update(modelId, "utf8").digest("hex");
}

function badRequest(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "BAD_REQUEST",
    message,
    retryable: false
  });
}

function securityBoundary(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message,
    retryable: false
  });
}

function storageUnavailable(message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "STORAGE_UNAVAILABLE",
    message,
    retryable: true
  });
}
