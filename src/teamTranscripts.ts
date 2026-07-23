// SPDX-FileCopyrightText: 2026 CoreWeave, Inc.
// SPDX-License-Identifier: MIT
// SPDX-PackageName: weave-claude-code

import { parseSessionFd } from './parser.js';
import type { ParsedTurn } from './parser.js';
import { TranscriptFile } from './transcriptFile.js';

/** Read the transcript explicitly named by TeammateIdle. Correlation through
 * metadata and neighboring transcript discovery belongs to the recovery layer. */
export function readTeammateTurns(transcriptPath: string): ParsedTurn[] {
  let transcript: TranscriptFile | undefined;
  try {
    transcript = new TranscriptFile(transcriptPath);
    return parseSessionFd(transcript.getFd())?.turns
      .filter(turn => turn.responses.length) ?? [];
  } catch {
    return [];
  } finally {
    transcript?.close();
  }
}
