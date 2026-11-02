/** An existing, exactly identified native message; never replacement answer content. */
export interface ExternalTurnAnswerAnchor {
  answerSeq: number
  answerStep: number
  messageId: string
  turnEndSeq: number
}

/** Optional recovery for verified legacy CLI turns with reasoning/empty cleanup steps. */
export type ExternalTurnAnswer = Readonly<Record<string, ExternalTurnAnswerAnchor>>
