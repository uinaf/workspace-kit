import { gitEnvironmentForRepository } from "../src/lib/gitProcess.ts";

const repositoryEnvironment = gitEnvironmentForRepository();

for (const key of Object.keys(process.env)) {
  if (!Object.hasOwn(repositoryEnvironment, key)) delete process.env[key];
}
