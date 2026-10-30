import { createElement } from 'react';
import { registerSlot } from '../screens/pet/parts';
import { AccountControl } from './AccountControl';

// The Pet screen draws «Account» through its `account` slot (add-pet › design: the parts other changes own).
registerSlot('account', ({ tokenId, name, viewer }) => createElement(AccountControl, { tokenId, name, viewer }));
