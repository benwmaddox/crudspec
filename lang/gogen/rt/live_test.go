package rt

import (
	"reflect"
	"testing"
)

// What a query reads, from SQL texts as the planner writes them (Campfire's).
func TestParseWhere(t *testing.T) {
	cases := []struct {
		where string
		want  []readKey
	}{
		{``, []readKey{{table: "Message"}}},
		{`(t0."room" IS ?)`, []readKey{{table: "Message", col: "room", arg: 0}}},
		{`(t0."user" IS ?) AND ((SELECT "type" FROM "Room" x WHERE x.id = t0."room") IS ?) AND (EXISTS (SELECT 1 FROM "Membership" t1 WHERE ((t1."room" IS t0."room") AND (t1."user" IS ?))))`,
				[]readKey{{table: "Message", col: "user", arg: 0}, {table: "Room", col: "type", arg: 1}, {table: "Membership", col: "user", arg: 2}}},
		{`(t0.id IN (SELECT value FROM json_each(?))) AND (EXISTS (SELECT 1 FROM "Membership" t1 WHERE ((t1."room" IS ?) AND (t1."user" IS t0.id))))`,
			[]readKey{{table: "Message", col: "id[]", arg: 0}, {table: "Membership", col: "room", arg: 1}}},
		// a lookup of the same row adds nothing; a lookup compared with a parameter reads col=v
		{`(t0."user" IS ?) AND (NOT ((SELECT "involvement" FROM "Message" x WHERE x.id = t0.id) IS ?))`,
			[]readKey{{table: "Message", col: "user", arg: 0}}},
		{`(t0."room" IS ?) AND (EXISTS (SELECT 1 FROM "Membership" t1 WHERE ((t1."room" IS (SELECT "room" FROM "Message" x WHERE x.id = t0.id)) AND (t1."user" IS ?))))`,
			[]readKey{{table: "Message", col: "room", arg: 0}, {table: "Membership", col: "user", arg: 1}}},
		{`(t0."user" IS ?) AND ((SELECT "type" FROM "Room" x WHERE x.id = t0."room") IS ?)`,
			[]readKey{{table: "Message", col: "user", arg: 0}, {table: "Room", col: "type", arg: 1}}},
		// an OR: its equalities don't constrain the query
		{`(t0."room" IS ?) OR (t0."user" IS ?)`, []readKey{{table: "Message", cols: []string{"room", "user"}}}},
		{`(t0."creator" IS ?) AND ((t0."room" IS ?) OR (t0."user" IS ?))`, []readKey{{table: "Message", col: "creator", arg: 0}}},
		// an OR inside a subquery leaves the outer equality alone
		{`(t0."room" IS ?) AND (EXISTS (SELECT 1 FROM "Boost" t1 WHERE (t1."message" IS t0.id) OR (t1."booster" IS ?)))`,
			[]readKey{{table: "Message", col: "room", arg: 0}, {table: "Boost", cols: []string{"message", "booster"}}}},
		{`t0.id = ?`, []readKey{{table: "Message", col: "id", arg: 0}}},
		// a ? inside a quoted string is not a parameter
		{`(t0."body" = 'what?') AND (t0."room" = ?)`, []readKey{{table: "Message", col: "room", arg: 0}}},
		// a comparison other than equality reads the whole table
		{`(t0."seq" > ?)`, []readKey{{table: "Message", cols: []string{"seq"}}}},
		{`(t0.created, t0.seq) < (?, ?)`, []readKey{{table: "Message", cols: []string{"created", "seq"}}}},
	}
	for _, c := range cases {
		if got := parseWhere("Message", c.where); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", c.where, got, c.want)
		}
	}
}

// A write's keys meet the reads of a page that shows the row, and not those of one that doesn't.
func TestLiveKeys(t *testing.T) {
	e := &Entity{Name: "Message", Stored: true, Fields: []Field{{Name: "room"}, {Name: "body"}}}
	read := func(where string, args ...any) Deps {
		s := &Sess{Reads: Deps{}}
		s.readWhere(e, where, args)
		return s.Reads
	}
	wrote := func(old, now []any) Deps {
		s := &Sess{}
		s.wrote(e, 7, old, now)
		return s.wkeys
	}
	meets := func(a, b Deps) bool {
		for k := range a {
			if _, ok := b[k]; ok {
				return true
			}
		}
		return false
	}
	room1, room2 := read(`(t0."room" IS ?)`, int64(1)), read(`(t0."room" IS ?)`, int64(2))
	post := wrote(nil, []any{int64(1), "hi"})
	if !meets(room1, post) || meets(room2, post) {
		t.Fatalf("a post in room 1: room 1 %v, room 2 %v", meets(room1, post), meets(room2, post))
	}
	moved := wrote([]any{int64(2), "hi"}, []any{int64(1), "hi"})
	if !meets(room2, moved) {
		t.Fatal("a row moved out of room 2 must reach room 2's page")
	}
	if !meets(room2, wrote(nil, nil)) {
		t.Fatal("a delete whose values aren't known must reach every page that read the table")
	}
	if !meets(read(``), post) {
		t.Fatal("a page that read the whole table sees every write to it")
	}
}
