import { gitEnvironmentForRepository } from "../src/lib/gitProcess.ts";

// Git hooks export the outer repository's GIT_DIR, GIT_INDEX_FILE, and other repository-local
// variables; fixture repos must not inherit anything gitEnvironmentForRepository strips.
const repositoryEnvironment = gitEnvironmentForRepository();
for (const key of Object.keys(process.env)) {
  if (!Object.hasOwn(repositoryEnvironment, key)) delete process.env[key];
}
