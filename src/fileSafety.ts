import fs from "node:fs";
import path from "node:path";
import type { HermesRuntimeOptions } from "./types.js";
import { resolveHermesPaths } from "./db.js";

export interface SafeFileRead {
  content: string;
  sourceLabel: string;
  absolutePath: string;
}

export function readExplicitIntakeFile(
  filePath: string,
  options: HermesRuntimeOptions & { allowExternalFile?: boolean } = {}
): SafeFileRead {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error("File path is required.");
  }

  const paths = resolveHermesPaths(options);
  const requestedPath = path.resolve(paths.projectRoot, filePath);
  const stat = fs.statSync(requestedPath);

  if (!stat.isFile()) {
    throw new Error("File intake accepts one explicit file path. Directories are not allowed.");
  }

  const realProjectRoot = fs.realpathSync(paths.projectRoot);
  const realFilePath = fs.realpathSync(requestedPath);
  const insideProject = isInsidePath(realProjectRoot, realFilePath);

  if (!insideProject && !options.allowExternalFile) {
    throw new Error(
      "External file intake requires --allow-external-file. HERmes will still write only under .hermes/."
    );
  }

  return {
    content: fs.readFileSync(realFilePath, "utf8"),
    sourceLabel: insideProject ? path.relative(paths.projectRoot, requestedPath) : realFilePath,
    absolutePath: realFilePath
  };
}

export function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
