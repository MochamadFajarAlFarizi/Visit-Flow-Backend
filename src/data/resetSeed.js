import { resetStore } from "./store.js";

const store = resetStore();
console.log(
  `Seed data reset: ${store.users.length} users, ${store.masterEntities.length} master entities, ${store.activities.length} activities.`
);

