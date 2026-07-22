type GitRemote = { host: string; repository: string };

const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

export function normalizeGitHost(host: string): string | undefined {
  return host.length <= 253 && host === host.trim() && HOST.test(host)
    ? host.toLowerCase()
    : undefined;
}

export function isGitRepositoryPath(repository: string): boolean {
  return (
    REPOSITORY.test(repository) &&
    repository.split("/").every((part) => part !== "." && part !== ".." && !part.endsWith(".git"))
  );
}

function normalizeRepository(path: string): string | undefined {
  const repository = path.endsWith(".git") ? path.slice(0, -4) : path;
  return isGitRepositoryPath(repository) ? repository : undefined;
}

export function parseGitRemote(input: string): GitRemote | undefined {
  const remote = input.trim();
  if (remote.includes("\0") || /[%\s\\]/.test(remote) || /(?:^|[/:])\.{1,2}(?:\/|$)/.test(remote)) {
    return undefined;
  }

  const scp = remote.match(/^git@([^:]+):(.+)$/);
  let host: string;
  let path: string;

  if (scp) {
    const [, scpHost = "", scpPath = ""] = scp;
    host = scpHost;
    path = scpPath;
  } else {
    if (!URL.canParse(remote)) return undefined;
    const url = new URL(remote);
    const validProtocol =
      (url.protocol === "https:" && !url.username) ||
      (url.protocol === "ssh:" && url.username === "git");
    if (!validProtocol || url.password || url.port || url.search || url.hash) {
      return undefined;
    }
    host = url.hostname;
    path = url.pathname.slice(1);
  }

  const normalizedHost = normalizeGitHost(host);
  const repository = normalizeRepository(path);
  return normalizedHost && repository ? { host: normalizedHost, repository } : undefined;
}
