import { Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../db/db.service";

/**
 * Statutory rules resolution (02-kenya-compliance.md): returns the payload
 * of a rule as of a given date. Rates/limits are DATA shipped via seeded
 * migrations with source citations — a gazette change is a migration, not
 * a code change, and historical payrolls re-resolve their period's rules.
 */
@Injectable()
export class RulesService {
  constructor(private readonly db: DbService) {}

  async get<T>(
    ruleKey: string,
    asOf: string, // ISO date (YYYY-MM-DD)
    jurisdiction = "KE",
  ): Promise<T> {
    const res = await this.db.query(
      `SELECT payload FROM statutory_rules
       WHERE jurisdiction = $1 AND rule_key = $2
         AND effective_from <= $3
         AND (effective_to IS NULL OR effective_to >= $3)
       ORDER BY effective_from DESC
       LIMIT 1`,
      [jurisdiction, ruleKey, asOf],
    );
    if (!res.rows[0]) {
      throw new NotFoundException(
        `No statutory rule '${ruleKey}' (${jurisdiction}) effective ${asOf}`,
      );
    }
    return res.rows[0].payload as T;
  }
}
