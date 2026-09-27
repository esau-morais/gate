import { Option, Schema } from 'effect';

export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9.-]+(\/[^/\s]+){2,}$/),
).pipe(Schema.brand('RepositoryName'));
export type RepositoryName = typeof RepositoryName.Type;

const decodeName = Schema.decodeUnknownOption(RepositoryName);

function hostAndPath(url: string): [string, string] | undefined {
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (shorthand?.[1] !== undefined) {
    return ['github.com', shorthand[1]];
  }

  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url);
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return [scp[1], scp[2]];
  }

  let parsed: URL;
  try {
    parsed = new URL(url.replace(/^git\+/, ''));
  } catch {
    return undefined;
  }

  return ['https:', 'http:', 'git:', 'ssh:'].includes(parsed.protocol)
    ? [parsed.hostname.replace(/^www\./, ''), parsed.pathname]
    : undefined;
}

export function repositoryName(url: string): RepositoryName | undefined {
  const located = hostAndPath(url.trim().replace(/#.*$/, ''));
  if (located === undefined) {
    return undefined;
  }

  const [host, path] = located;
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  const [owner, repo, view] = segments;
  if (host !== 'github.com') {
    return Option.getOrUndefined(
      decodeName(`${host}/${segments.join('/')}`.toLowerCase()),
    );
  }

  return segments.length === 2 || view === 'tree' || view === 'blob'
    ? Option.getOrUndefined(
        decodeName(`${host}/${owner}/${repo}`.toLowerCase()),
      )
    : undefined;
}
