import {
  aboutTicketText,
  projectDone,
  sendsNewPod,
  ticketIdsIn,
} from '../client/NewPodForm';

describe('New pod — the one box reads ticket ids as the server does', () => {
  it('in order, upper-cased, each once', () => {
    expect(ticketIdsIn('pawnee-84, PAWNEE-83 and PAWNEE-84 again')).toEqual([
      'PAWNEE-84',
      'PAWNEE-83',
    ]);
    expect(ticketIdsIn('rangers repaint the trail markers')).toEqual([]);
  });
});

describe('⏎ in the new-pod box', () => {
  const press = (overrides: Partial<Parameters<typeof sendsNewPod>[0]>) =>
    sendsNewPod({
      key: 'Enter',
      shiftKey: false,
      composing: false,
      inBox: true,
      ...overrides,
    });

  it('starts the pod when it’s pressed in the box itself', () => {
    expect(press({})).toBe(true);
  });

  it('leaves ⏎ in the Add a project / New project dialog to that dialog', () => {
    // The dialog sits inside the new-pod section, so its keys bubble there:
    // ⏎ in "Sweetums recipe app" must make the project, not a pod.
    expect(press({ inBox: false })).toBe(false);
  });

  it('is a new line with ⇧, and nothing while an IME is composing', () => {
    expect(press({ shiftKey: true })).toBe(false);
    expect(press({ composing: true })).toBe(false);
    expect(press({ key: 'a' })).toBe(false);
  });
});

describe('a project made from the new-pod box', () => {
  it('opens the pod New project started with the idea, and empties the box', () => {
    expect(
      projectDone('new', 'A map of every dog park', {
        projectId: 'prj_sweetums',
        podId: 'nougat-tracker',
      })
    ).toEqual({
      chosen: 'prj_sweetums',
      clearBox: true,
      open: 'nougat-tracker',
    });
  });

  it('only picks the project when nothing was started', () => {
    expect(
      projectDone('new', '', { projectId: 'prj_sweetums', podId: null })
    ).toEqual({ chosen: 'prj_sweetums', clearBox: false, open: null });
    expect(
      projectDone('add', 'A map of every dog park', { projectId: 'prj_pawnee' })
    ).toEqual({ chosen: 'prj_pawnee', clearBox: false, open: null });
  });
});

describe('a chat about a ticket', () => {
  it("reads a sub-ticket's id, its letter kept small", () => {
    expect(ticketIdsIn('Plan pawnee-2a and PAWNEE-12 Park map page')).toEqual([
      'PAWNEE-2a',
      'PAWNEE-12',
    ]);
  });

  it('starts with the ticket, then what was typed, or asks for a summary when nothing was', () => {
    const about = { id: 'PAWNEE-2a', title: 'Park map page' };

    expect(aboutTicketText(about, '  Should Ramsett show? ')).toBe(
      'About PAWNEE-2a Park map page: Should Ramsett show?'
    );
    expect(aboutTicketText(about, '')).toBe(
      "About PAWNEE-2a Park map page: sum up this ticket, then ask me what I'd like to work out or change."
    );
  });
});
