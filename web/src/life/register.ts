import { registerSlot } from '../screens/pet/parts';
import { EnergySlot, GrowthSlot } from './LifeSlots';

// The energy meter and the stage with its traits stand where the Pet screen's frames have them (add-pet-life › Pet life
// display rule); the screen hands them `life` for the owner only.
registerSlot('energy', EnergySlot);
registerSlot('growth', GrowthSlot);
