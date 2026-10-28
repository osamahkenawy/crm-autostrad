// One tiny page per resource: the config does the work (see components/CrudPage).
import CrudPage from '../components/CrudPage';
import { branches, vehicles } from '../config/fleet';
import { customers, leads, tasks, team } from '../config/people';
import { bookings, contracts, fines, invoices, maintenance } from '../config/operations';

export const Fleet = () => <CrudPage key="vehicles" config={vehicles} />;
export const Branches = () => <CrudPage key="branches" config={branches} />;
export const Customers = () => <CrudPage key="customers" config={customers} />;
export const Team = () => <CrudPage key="team" config={team} />;
export const Leads = () => <CrudPage key="leads" config={leads} />;
export const Tasks = () => <CrudPage key="tasks" config={tasks} />;
export const Bookings = () => <CrudPage key="bookings" config={bookings} />;
export const Contracts = () => <CrudPage key="contracts" config={contracts} />;
export const Maintenance = () => <CrudPage key="maintenance" config={maintenance} />;
export const Fines = () => <CrudPage key="fines" config={fines} />;
export const Invoices = () => <CrudPage key="invoices" config={invoices} />;
