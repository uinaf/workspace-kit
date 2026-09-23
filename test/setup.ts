import { gitEnvironmentForRepository } from "../src/lib/gitProcess.ts";

// Git hooks export the outer repository's GIT_INDEX_FILE and GIT_DIR; fixture repos must not inherit them.
const repositoryEnvironment = gitEnvironmentForRepository();
for (const key of Object.keys(process.env)) {
  if (!(key in repositoryEnvironment)) delete process.env[key];
}
