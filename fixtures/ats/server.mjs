import { createServer } from "node:http";

export const FIXTURE_PORT = 41731;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
export const FIXTURE_FRAME_PORT = 41732;
export const FIXTURE_FRAME_ORIGIN = `http://127.0.0.1:${FIXTURE_FRAME_PORT}`;

const ATS = {
  greenhouse: '<main id="grnhse_app"><form id="application_form">',
  lever: '<main class="application-form"><form data-qa="application-form">',
  ashby: '<main class="_ashby_root ashby-application-form"><form>',
  smartrecruiters:
    '<main data-test="job"><form data-testid="application-form">',
  workday: '<main data-automation-id="jobApplicationPage"><form>',
  icims: '<main id="icims_content"><form>',
  taleo: '<main><form name="dform">',
};

function commonFields() {
  return `
    <label>Full name <input id="full-name" name="candidate_name" autocomplete="name"></label>
    <label>Email address <input id="email" name="email" type="email" autocomplete="email"></label>
    <label>Phone number <input id="phone" name="phone" type="tel" autocomplete="tel"></label>
    <label>Phone number already supplied <input id="existing-phone" name="existing-phone" type="tel" value="+1 555 010 9999"></label>
    <label>LinkedIn profile <input id="linkedin" name="linkedin" type="url"></label>
    <label>Country <select id="country" name="country"><option value="">Choose</option><option value="US">United States</option></select></label>
    <fieldset><legend>Are you authorized to work?</legend>
      <label><input type="radio" name="work-authorized" value="yes"> Yes</label>
      <label><input type="radio" name="work-authorized" value="no"> No</label>
    </fieldset>
    <label><input id="updates" type="checkbox" name="updates"> Would you like to receive application updates?</label>
  `;
}

function complexFields() {
  return `
    <label>Preferred name <input id="react-name" name="preferred-name"></label>
    <span id="city-label">City</span><div id="city-combobox" role="combobox" aria-labelledby="city-label"><input></div>
    <span id="list-country-label">Country</span><div id="country-listbox" role="listbox" aria-labelledby="list-country-label">
      <div role="option" data-value="US" aria-selected="false">United States</div>
      <div role="option" data-value="CA" aria-selected="false">Canada</div>
    </div>
    <section id="employment-block"><h2>Employment history</h2><label>Current title <input id="current-title"></label></section>
    <section id="education-block"><h2>Education</h2><label>School <input id="school"></label></section>
    <button id="add-employment" type="button">Add employment</button>
    <div id="shadow-host"></div>
    <iframe id="same-origin-frame" src="/frame"></iframe>
    <iframe id="cross-origin-placeholder" sandbox srcdoc="<p>Fake cross-origin placeholder; not a real site.</p>"></iframe>
    <label>Resume or CV <input id="resume" name="resume" type="file" accept="application/pdf"></label>
    <label>Cover letter <input id="cover-letter" name="cover-letter" type="file"></label>
    <label>Transcript <input id="transcript" name="transcript" type="file"></label>
    <div id="dropzone" role="button" aria-label="Upload portfolio dropzone">Drop files here</div>
  `;
}

function siteSpecificFields(family) {
  if (family === "lever") {
    return `
      <div id="unrelated-lever-option" role="option">Seattle, Washington, United States</div>
      <div class="application-question">
        <div>
          <div class="application-label"><div class="text">Current location</div></div>
          <div class="application-field">
            <input id="location-input" class="location-input" data-qa="location-input" name="location">
            <input id="selected-location" type="hidden" name="selectedLocation">
            <div class="dropdown-results"></div>
          </div>
        </div>
      </div>
      <div class="application-question">
        <div>
          <div class="application-label"><div class="text">How did you hear about this opportunity?</div></div>
          <div class="application-field">
            <select id="source"><option value="">Select</option><option value="linkedin">LinkedIn</option><option value="other">Other</option></select>
          </div>
        </div>
      </div>
    `;
  }
  if (family === "ashby") {
    return `
      <div class="ashby-application-form-autofill-input-root">
        <input id="ashby-resume-parser" type="file">
      </div>
      <div class="ashby-application-form-field-entry" data-field-path="_systemfield_location">
        <label class="ashby-application-form-question-title" for="ashby-location">Where are you currently located?</label>
        <div class="ashby-location-input-container">
          <input id="ashby-location" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" placeholder="Start typing...">
          <div class="ashby-location-options"></div>
        </div>
      </div>
      <div class="ashby-application-form-field-entry" data-field-path="start_date">
        <label class="ashby-application-form-question-title" for="ashby-start-date">When can you start a new role?</label>
        <input id="ashby-start-date" placeholder="Pick date...">
      </div>
      <div id="unrelated-ashby-option" role="option">Seattle, Washington, United States</div>
    `;
  }
  if (family === "smartrecruiters") {
    return `
      <label>Please select your gender
        <select id="sr-gender"><option value="" selected>Please Select</option><option value="man">Man</option><option value="woman">Woman</option></select>
      </label>
      <label>Please select your race/ethnicity
        <select id="sr-race"><option value="" selected>Please Select</option><option value="asian-us">Asian (United States of America)</option><option value="other">Other</option></select>
      </label>
      <label>Please select your veteran status
        <select id="sr-veteran"><option value="" selected>Please Select</option><option value="not-veteran">I am not a veteran</option><option value="veteran">I am a veteran</option></select>
      </label>
      <label>Are you currently or previously appointed as a U.S. Government Official, or employed by a U.S. Government or Foreign Government entity in any capacity?
        <select id="sr-government"><option value="" selected>Please Select</option><option value="yes">Yes</option><option value="no">No</option></select>
      </label>
      <label>Do you have a family relationship (biological, adopted, marriage, domestic partnership, civil union, or some other arrangement) with, or are you a close personal contact (a regular and ongoing close connection that may be personal, romantic, financial, or any other type of relationship that could be perceived as more than general acquaintance) of U.S. Government or Foreign Government Official?
        <select id="sr-government-family"><option value="" selected>Please Select</option><option value="yes">Yes</option><option value="no">No</option></select>
      </label>
      <label><input id="sr-certify" type="checkbox">I certify that the information provided is correct</label>
    `;
  }
  return "";
}

function protectedAndDecoys() {
  return `
    <section class="captcha"><p>CAPTCHA challenge placeholder — never interact.</p><input id="decoy-captcha" name="captcha-response"></section>
    <label>Site search <input id="decoy-search" type="search" name="search"></label>
    <section class="login"><label>Login username <input id="decoy-login" name="username"></label><label>Password <input id="decoy-password" type="password"></label></section>
    <section class="payment"><label>Card number <input id="decoy-payment" name="card-number"></label></section>
    <label>Desired salary <input id="salary"></label>
    <label>Gender / EEO <input id="eeo"></label>
    <label>Disability status <input id="disability"></label>
    <label>Protected veteran status <input id="veteran"></label>
    <label>Have you ever been convicted of a felony? <input id="legal"></label>
    <label>I certify that the information is correct <input id="certify"></label>
    <label>Coding assessment availability <input id="assessment"></label>
    <button id="next" type="button">Next</button><button id="submit" type="submit">Submit application</button>
  `;
}

function page(family) {
  const root = ATS[family] ?? "<main><form>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fake ${family ?? "generic"} application</title></head>
  <body>${root}${commonFields()}${family === "generic" ? complexFields() : ""}${siteSpecificFields(family)}${protectedAndDecoys()}</form></main>
  <script>
    window.fixtureEvents = { clicks: 0, input: 0, change: 0, reactObserved: 0, navigation: 0, dynamicOptionMouseDown: 0, unrelatedOptionMouseDown: 0, enter: 0 };
    for (const id of ['next', 'submit']) document.getElementById(id).addEventListener('click', (event) => {
      event.preventDefault(); window.fixtureEvents.clicks++; throw new Error('navigation trap activated');
    });
    for (const id of ['decoy-search', 'decoy-login', 'decoy-password', 'decoy-payment', 'decoy-captcha', 'assessment']) {
      const el = document.getElementById(id);
      for (const event of ['input', 'change']) el.addEventListener(event, () => { window.fixtureEvents[event]++; throw new Error('decoy received event'); });
    }
    const react = document.getElementById('react-name');
    react?.addEventListener('input', () => { window.fixtureEvents.reactObserved++; });
    document.getElementById('add-employment')?.addEventListener('click', () => {
      const label = document.createElement('label'); label.textContent = 'Current company ';
      const input = document.createElement('input'); input.id = 'dynamic-company'; label.append(input);
      document.getElementById('employment-block').append(label);
    });
    const shadow = document.getElementById('shadow-host')?.attachShadow({ mode: 'open' });
    if (shadow) shadow.innerHTML = '<label>Portfolio <input id="shadow-portfolio" type="url"></label>';
    const leverLocation = document.getElementById('location-input');
    if (leverLocation) {
      const results = leverLocation.parentElement.querySelector('.dropdown-results');
      leverLocation.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          window.fixtureEvents.enter++;
          throw new Error('enter trap activated');
        }
        setTimeout(() => {
          results.innerHTML = '<div class="dropdown-location">Seattle, Washington, United States</div>';
          results.firstElementChild.addEventListener('mousedown', (optionEvent) => {
            window.fixtureEvents.dynamicOptionMouseDown++;
            leverLocation.value = optionEvent.currentTarget.textContent;
            document.getElementById('selected-location').value = '{"name":"Seattle, Washington, United States"}';
            results.innerHTML = '';
          });
        }, 20);
      });
      document.getElementById('unrelated-lever-option').addEventListener('mousedown', () => {
        window.fixtureEvents.unrelatedOptionMouseDown++;
        throw new Error('unrelated option trap activated');
      });
    }
    const ashbyLocation = document.getElementById('ashby-location');
    if (ashbyLocation) {
      const results = ashbyLocation.parentElement.querySelector('.ashby-location-options');
      ashbyLocation.addEventListener('input', () => {
        results.innerHTML = '<div role="option">Seattle, Washington, United States</div>';
        results.firstElementChild.addEventListener('mousedown', (optionEvent) => {
          window.fixtureEvents.dynamicOptionMouseDown++;
          ashbyLocation.value = optionEvent.currentTarget.textContent;
          results.innerHTML = '';
        });
      });
      document.getElementById('unrelated-ashby-option').addEventListener('mousedown', () => {
        window.fixtureEvents.unrelatedOptionMouseDown++;
        throw new Error('unrelated option trap activated');
      });
    }
  </script></body></html>`;
}

function frame() {
  return `<!doctype html><title>Fake same-origin application frame</title>
    <label>Phone number <input id="frame-phone" type="tel"></label>`;
}

function embeddedGreenhousePage() {
  return `<!doctype html><html><head><title>Embedded Greenhouse fixture</title></head>
    <body><h1>Embedded application</h1>
      <iframe id="greenhouse-embed" title="Greenhouse Job Board" src="${FIXTURE_FRAME_ORIGIN}/greenhouse-frame"></iframe>
    </body></html>`;
}

function greenhouseFrame() {
  return `<!doctype html><html><body><div id="grnhse_app"><form id="application_form">
    <svg class="select2-icon" aria-hidden="true"></svg>
    <label>First Name <input id="first_name"></label>
    <label>Last Name <input id="last_name"></label>
    <label>Email <input id="email" type="email"></label>
    <fieldset><legend>Phone</legend>
      <label>Country
        <div class="select-shell"><span class="select__single-value"></span><input id="country" role="combobox" autocomplete="off"></div>
      </label>
      <label>Phone <input id="phone" type="tel"></label>
    </fieldset>
    <label>Are you legally authorized to work?
      <div class="select-shell"><span class="select__single-value"></span><input id="work_authorized" role="combobox" autocomplete="off"></div>
    </label>
    <label>Location (City)
      <div class="select-shell"><span class="select__single-value"></span><input id="candidate-location" class="select__input" role="combobox" aria-autocomplete="list" data-jobseek-options="[]"></div>
    </label>
    <button id="submit" type="submit">Submit</button>
  </form></div>
  <script>
    window.fixtureEvents = { clicks: 0, locationSelections: 0 };
    document.getElementById('submit').addEventListener('click', (event) => {
      event.preventDefault(); window.fixtureEvents.clicks++; throw new Error('submit trap activated');
    });
    let countryApi = null;
    document.getElementById('phone').addEventListener('input', (event) => {
      event.currentTarget.value = event.currentTarget.value.replace(/(\\d{1}) (\\d{3}) (\\d{3}) (\\d{4})/, '$1 $2-$3-$4');
      if (event.currentTarget.value && countryApi?.getValue().length === 0) {
        countryApi.selectOption(countryApi.options[0]);
      }
    });
    function installSelect(id, options) {
      const input = document.getElementById(id);
      const display = input.closest('.select-shell').querySelector('.select__single-value');
      let selected = null;
      const api = {
        options,
        selectOption(option) { selected = option; display.textContent = option.label; },
        clearValue() { selected = null; display.textContent = ''; },
        getValue() { return selected ? [selected] : []; }
      };
      input.__reactFiber$fixture = { memoizedProps: api, return: null };
      return api;
    }
    countryApi = installSelect('country', [
      { label: 'United States', value: 'US' },
      { label: 'Canada', value: 'CA' }
    ]);
    installSelect('work_authorized', [
      { label: 'Yes', value: 1 },
      { label: 'No', value: 0 }
    ]);
    const locationInput = document.getElementById('candidate-location');
    const locationDisplay = locationInput.closest('.select-shell').querySelector('.select__single-value');
    let locationSelected = null;
    const locationApi = {
      options: [],
      selectOption(option) {
        locationSelected = option;
        locationInput.value = option.label;
        locationDisplay.textContent = option.label;
      },
      clearValue() {
        locationSelected = null;
        locationInput.value = '';
        locationDisplay.textContent = '';
      },
      getValue() { return locationSelected ? [locationSelected] : []; }
    };
    locationInput.__reactFiber$dynamicFixture = { memoizedProps: locationApi, return: null };
    locationInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        window.fixtureEvents.clicks++;
        throw new Error('enter trap activated');
      }
    });
    locationInput.addEventListener('keyup', () => {
      const shell = locationInput.closest('.select-shell');
      let menu = shell.querySelector('.dynamic-location-options');
      if (!menu) {
        menu = document.createElement('div');
        menu.className = 'dynamic-location-options';
        shell.append(menu);
      }
      menu.innerHTML = '<div role="option">Seattle, Washington, United States</div><div role="option">Seattle, Washington, United States</div><div role="option">Seattle Bar, Oregon, United States</div>';
      for (const option of menu.querySelectorAll('[role="option"]')) {
        option.addEventListener('mousedown', () => {
          window.fixtureEvents.locationSelections++;
          locationSelected = { label: option.textContent, value: option.textContent };
          locationInput.value = '';
          locationDisplay.textContent = option.textContent;
          menu.innerHTML = '';
        });
      }
    });
  </script></body></html>`;
}

export function startFixtureServer() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", FIXTURE_ORIGIN).pathname;
    if (path === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(frame());
      return;
    }
    if (path === "/embedded-greenhouse") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(embeddedGreenhousePage());
      return;
    }
    const family = path.slice(1) || "generic";
    if (family === "generic" || Object.hasOwn(ATS, family)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(family));
      return;
    }
    response.writeHead(404).end("Fixture not found");
  });
  const frameServer = createServer((request, response) => {
    const path = new URL(request.url ?? "/", FIXTURE_FRAME_ORIGIN).pathname;
    if (path === "/greenhouse-frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(greenhouseFrame());
      return;
    }
    response.writeHead(404).end("Fixture not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    frameServer.once("error", reject);
    frameServer.listen(FIXTURE_FRAME_PORT, "127.0.0.1", () => {
      server.listen(FIXTURE_PORT, "127.0.0.1", () =>
        resolve({
          close(callback) {
            let pending = 2;
            let firstError;
            const done = (error) => {
              firstError ??= error;
              pending -= 1;
              if (pending === 0) callback(firstError);
            };
            server.close(done);
            frameServer.close(done);
          },
        }),
      );
    });
  });
}
