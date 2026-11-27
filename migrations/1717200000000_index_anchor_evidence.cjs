exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX indexed_anchor_events_evidence_idx ON indexed_anchor_events
      (slot_name, chain_id, LOWER(anchor_contract_address), LOWER(payload_json ->> 'key'),
       LOWER(owner_address), block_number DESC, transaction_index DESC, log_index DESC)
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX indexed_anchor_events_evidence_idx');
};
