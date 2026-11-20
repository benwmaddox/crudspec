package rt

// A row's address (entity … { address slug }): in a screen's route, a row of such an entity is
// named by that field, unique and text (/w/hollow-depths), not by its id. Links write the
// field's value (URLPart), and an address part is looked up by it (CoerceRef), each one query
// through the field's unique index, on the database's lookup readers (DB.A), not a request's. A
// field that changes changes the row's address; its old links no longer find it.

var addressField = map[string]string{} // entity -> its address field (generated: SetAddress)
var addressDB *DB                       // the app's database, for the lookups (main)

// SetAddress says entity's rows are named by field in addresses.
func SetAddress(entity, field string) { addressField[entity] = field }

// addressOf is a row's address, when its entity has one and the row is there.
func addressOf(r Ref) (string, bool) {
	f, ok := addressField[r.E]
	if !ok || addressDB == nil {
		return "", false
	}
	var s string
	if addressDB.A.QueryRow(`SELECT `+Q(f)+` FROM `+Q(r.E)+` WHERE id = ?`, r.ID).Scan(&s) != nil {
		return "", false
	}
	return s, true
}

// rowAt is the id of entity's row with this address.
func rowAt(entity, address string) (int64, bool) {
	f, ok := addressField[entity]
	if !ok || addressDB == nil {
		return 0, false
	}
	var id int64
	if addressDB.A.QueryRow(`SELECT id FROM `+Q(entity)+` WHERE `+Q(f)+` = ?`, address).Scan(&id) != nil {
		return 0, false
	}
	return id, true
}
