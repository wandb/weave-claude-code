import { spawnSync } from 'node:child_process';

/**
 * Turn `git describe` output into a build version string.
 *
 * On an exact, clean release tag the base version is returned unchanged (the
 * published release reports e.g. `0.2.9`). Anything ahead of the tag, or a dirty
 * working tree, appends semver build metadata (the `+…` part, which §10 of the
 * semver spec ignores for precedence) so dev builds are distinguishable:
 *   `0.2.9+8.gabc1234`        — 8 commits past v0.2.9
 *   `0.2.9+8.gabc1234.dirty`  — …with uncommitted changes
 *
 * The base version is taken from `baseVersion` (the release-automation source of
 * truth), never from the tag name, so it stays correct even if a tag drifts.
 * Parsing anchors at the end of the string because pre-release base versions can
 * themselves contain hyphens (e.g. `v0.2.8-rc.0-3-gdef5678`).
 *
 * @param {string} baseVersion - clean semver, e.g. `0.2.9`.
 * @param {string} describeOutput - raw `git describe --long --dirty --always` output.
 * @returns {string}
 */
export function buildVersionFrom(baseVersion, describeOutput) {
  const raw = (describeOutput || '').trim();
  if (!raw) return baseVersion;

  let dirty = false;
  let rest = raw;
  if (rest.endsWith('-dirty')) {
    dirty = true;
    rest = rest.slice(0, -'-dirty'.length);
  }

  // `--long` form: <tag>-<count>-g<sha>. Anchored at the end; the tag prefix
  // (which may contain hyphens) is ignored in favor of baseVersion.
  const long = rest.match(/-(\d+)-g([0-9a-f]+)$/i);
  if (long) {
    const count = Number(long[1]);
    const sha = long[2];
    if (count === 0 && !dirty) return baseVersion;
    const meta = [String(count), `g${sha}`];
    if (dirty) meta.push('dirty');
    return `${baseVersion}+${meta.join('.')}`;
  }

  // `--always` fallback when no matching tag exists: a bare abbreviated sha.
  const bare = rest.match(/^([0-9a-f]{4,40})$/i);
  if (bare) {
    const meta = [`g${bare[1]}`];
    if (dirty) meta.push('dirty');
    return `${baseVersion}+${meta.join('.')}`;
  }

  // Unrecognized shape — don't guess; report the clean base version.
  return baseVersion;
}

/**
 * Resolve the build version for a checkout by running `git describe`. Any
 * failure (not a git repo, git missing, no output) falls back to `baseVersion`,
 * which is the correct behavior for a published npm tarball that ships without a
 * `.git` directory.
 *
 * @param {string} repoRoot - directory to run git in.
 * @param {string} baseVersion - clean semver fallback.
 * @returns {string}
 */
export function resolveBuildVersion(repoRoot, baseVersion) {
  try {
    const result = spawnSync(
      'git',
      ['describe', '--tags', '--long', '--dirty', '--always', '--match', 'v*'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    if (result.status !== 0 || !result.stdout) return baseVersion;
    return buildVersionFrom(baseVersion, result.stdout);
  } catch {
    return baseVersion;
  }
}
