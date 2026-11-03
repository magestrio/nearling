import { registerSlot } from '../screens/pet/parts';
import { AdviceColumn } from './AdviceColumn';
import { HiringSwitch } from './HiringSwitch';

// The hiring switch stands where the Pet screen's frames have it (add-pet-work › Hire mode rule): the card on the phone, under the
// input on the desktop. The guest's advice column (Advice flow) stands where the owner's conversation does: with it registered a
// guest with a pet of their own gets the frame's two columns.
registerSlot('hiring', HiringSwitch);
registerSlot('advice', AdviceColumn);
